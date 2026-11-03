//! Milestone Vault
//!
//! An escrow for website work. A client locks the payment for each milestone in this
//! contract. When the freelancer submits a milestone, an independent AI auditor opens the
//! site in a sandbox and reports the result. A milestone that passes the agreed checks is
//! paid to the freelancer automatically.
//!
//! The safety model is written into the contract, not into a prompt:
//! * The auditor can only call `report`. It never chooses who gets paid or how much:
//!   the recipient is always the job's freelancer and the amount is always that milestone's.
//! * The auditor signs with a function-call access key scoped to `report` on this contract,
//!   so it cannot transfer funds, deploy code or add keys, even if the agent is fooled.
//! * The client can always approve a milestone by hand, or take back unpaid milestones
//!   after the deadline.
//!
//! Payments are native NEAR or any NEP-141 token (for example USDC), chosen per job.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near,
    require, serde_json,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MAX_MILESTONES: usize = 10;
const MAX_REPORTS: usize = 30;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum MilestoneStatus {
    /// Funded, waiting for the freelancer.
    Open,
    /// The freelancer submitted a URL; waiting for the auditor.
    Submitted,
    /// The auditor found problems; the freelancer can fix them and submit again.
    Rejected,
    /// A payout is on its way (token transfer in flight).
    Paying,
    /// Paid to the freelancer.
    Released,
    /// Returned to the client after the deadline.
    Refunded,
}

/// What the site must reach for a milestone to be paid. Scores are 0-100.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Criteria {
    pub min_overall: u8,
    pub min_accessibility: u8,
    pub min_mobile: u8,
    pub min_seo: u8,
    pub max_broken_links: u8,
    /// Hostile scripts on the delivered site (credential theft, data exfiltration) fail it.
    pub forbid_malicious_scripts: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Milestone {
    pub title: String,
    pub amount: U128,
    pub status: MilestoneStatus,
    pub submitted_url: Option<String>,
    pub attempts: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Report {
    pub milestone: u8,
    pub url: String,
    pub passed: bool,
    pub overall: u8,
    /// sha256 of the full audit report, so anyone can check the published evidence.
    pub evidence_hash: String,
    pub summary: String,
    pub at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: U64,
    pub client: AccountId,
    pub freelancer: AccountId,
    pub title: String,
    /// None = native NEAR, Some(contract) = that NEP-141 token.
    pub token: Option<AccountId>,
    pub criteria: Criteria,
    pub milestones: Vec<Milestone>,
    pub deadline: U64,
    pub reports: Vec<Report>,
    pub created_at: U64,
}

/// Arguments for a new job (as JSON in `create_job` or in the `msg` of `ft_transfer_call`).
#[near(serializers = [json])]
#[derive(Clone)]
pub struct NewJob {
    pub freelancer: AccountId,
    pub title: String,
    pub criteria: Criteria,
    pub milestones: Vec<NewMilestone>,
    /// Deadline in seconds from now after which the client may take back unpaid milestones.
    pub deadline_secs: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct NewMilestone {
    pub title: String,
    pub amount: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    auditor: AccountId,
    next_id: u64,
    jobs: IterableMap<u64, Job>,
}

fn log_event(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({"standard": "milestone-vault", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, auditor: AccountId) -> Self {
        Self { owner, auditor, next_id: 0, jobs: IterableMap::new(b"j") }
    }

    // ---------------------------------------------------------------- client

    /// Create a job paid in native NEAR. Attach exactly the sum of the milestone amounts.
    #[payable]
    pub fn create_job(&mut self, job: NewJob) -> U64 {
        let deposit = env::attached_deposit().as_yoctonear();
        self.open_job(env::predecessor_account_id(), None, deposit, job)
    }

    /// NEP-141 receiver: create a job paid in a token, e.g. USDC.
    /// `msg` is the JSON of `NewJob`; the transferred amount must equal the milestone sum.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let job: NewJob = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be a NewJob JSON"));
        self.open_job(sender_id, Some(token), amount.0, job);
        PromiseOrValue::Value(U128(0))
    }

    /// The client can always approve a submitted or rejected milestone by hand.
    pub fn approve(&mut self, job_id: U64, milestone: u8) -> Promise {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.client, "Only the client can approve by hand");
        let m = &job.milestones[milestone as usize];
        require!(
            matches!(m.status, MilestoneStatus::Open | MilestoneStatus::Submitted | MilestoneStatus::Rejected),
            "Milestone is not payable"
        );
        let p = self.pay(&mut job, milestone, "client_approved");
        self.jobs.insert(job_id.0, job);
        p
    }

    /// After the deadline the client takes back every milestone that was not paid.
    pub fn refund(&mut self, job_id: U64) -> Promise {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.client, "Only the client can refund");
        require!(env::block_timestamp() >= job.deadline.0, "The deadline has not passed yet");
        let mut total: u128 = 0;
        for m in job.milestones.iter_mut() {
            if matches!(m.status, MilestoneStatus::Open | MilestoneStatus::Submitted | MilestoneStatus::Rejected) {
                total += m.amount.0;
                m.status = MilestoneStatus::Refunded;
            }
        }
        require!(total > 0, "Nothing to refund");
        log_event("refund", serde_json::json!({"job_id": job_id, "client": job.client, "amount": U128(total)}));
        let p = self.transfer(&job.token, job.client.clone(), total);
        self.jobs.insert(job_id.0, job);
        p
    }

    // ------------------------------------------------------------ freelancer

    /// The freelancer hands in a milestone: the URL the auditor should examine.
    pub fn submit(&mut self, job_id: U64, milestone: u8, url: String) {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.freelancer, "Only the freelancer can submit");
        require!(url.starts_with("https://") || url.starts_with("http://"), "URL must be http(s)");
        require!(url.len() <= 300, "URL too long");
        let m = job.milestones.get_mut(milestone as usize).unwrap_or_else(|| env::panic_str("No such milestone"));
        require!(matches!(m.status, MilestoneStatus::Open | MilestoneStatus::Rejected), "Milestone cannot be submitted now");
        m.status = MilestoneStatus::Submitted;
        m.submitted_url = Some(url.clone());
        m.attempts += 1;
        log_event("submit", serde_json::json!({"job_id": job_id, "milestone": milestone, "url": url}));
        self.jobs.insert(job_id.0, job);
    }

    // --------------------------------------------------------------- auditor

    /// The ONLY method the auditor's key can call. It records the verdict; a pass pays the
    /// milestone. The auditor cannot pick the recipient or the amount.
    pub fn report(
        &mut self,
        job_id: U64,
        milestone: u8,
        passed: bool,
        overall: u8,
        evidence_hash: String,
        summary: String,
    ) -> PromiseOrValue<()> {
        require!(env::predecessor_account_id() == self.auditor, "Only the auditor can report");
        require!(evidence_hash.len() == 64 && evidence_hash.chars().all(|c| c.is_ascii_hexdigit()), "evidence_hash must be sha256 hex");
        let mut job = self.job(job_id);
        let m = job.milestones.get(milestone as usize).unwrap_or_else(|| env::panic_str("No such milestone"));
        require!(m.status == MilestoneStatus::Submitted, "Milestone is not waiting for an audit");
        let url = m.submitted_url.clone().unwrap_or_default();
        let summary: String = summary.chars().take(280).collect();
        if job.reports.len() >= MAX_REPORTS { job.reports.remove(0); }
        job.reports.push(Report { milestone, url: url.clone(), passed, overall, evidence_hash: evidence_hash.clone(), summary, at: U64(env::block_timestamp()) });
        log_event("report", serde_json::json!({"job_id": job_id, "milestone": milestone, "passed": passed, "overall": overall, "evidence_hash": evidence_hash, "url": url}));
        if passed {
            let p = self.pay(&mut job, milestone, "audit_passed");
            self.jobs.insert(job_id.0, job);
            PromiseOrValue::Promise(p)
        } else {
            job.milestones[milestone as usize].status = MilestoneStatus::Rejected;
            self.jobs.insert(job_id.0, job);
            PromiseOrValue::Value(())
        }
    }

    // ----------------------------------------------------------------- owner

    pub fn set_auditor(&mut self, auditor: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can change the auditor");
        log_event("set_auditor", serde_json::json!({"auditor": auditor}));
        self.auditor = auditor;
    }

    // ----------------------------------------------------------------- views

    pub fn get_job(&self, job_id: U64) -> Option<Job> { self.jobs.get(&job_id.0).cloned() }

    pub fn get_jobs(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Job> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(100) as usize;
        self.jobs.values().skip(from).take(limit).cloned().collect()
    }

    /// Jobs with a milestone waiting for the auditor: (job_id, milestone, url).
    pub fn get_pending_audits(&self) -> Vec<(U64, u8, String)> {
        let mut out = vec![];
        for job in self.jobs.values() {
            for (i, m) in job.milestones.iter().enumerate() {
                if m.status == MilestoneStatus::Submitted {
                    out.push((job.id, i as u8, m.submitted_url.clone().unwrap_or_default()));
                }
            }
        }
        out
    }

    pub fn get_config(&self) -> serde_json::Value {
        serde_json::json!({"owner": self.owner, "auditor": self.auditor, "jobs": self.next_id})
    }

    // -------------------------------------------------------------- callback

    #[private]
    pub fn on_payout(&mut self, job_id: U64, milestone: u8) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        let mut job = self.job(job_id);
        let m = &mut job.milestones[milestone as usize];
        // A failed token transfer (e.g. freelancer not registered with the token) puts the
        // milestone back so it can be paid again; no funds are lost.
        m.status = if ok { MilestoneStatus::Released } else { MilestoneStatus::Submitted };
        log_event(if ok { "payout" } else { "payout_failed" }, serde_json::json!({"job_id": job_id, "milestone": milestone}));
        self.jobs.insert(job_id.0, job);
        ok
    }

    // -------------------------------------------------------------- internal

    fn job(&self, job_id: U64) -> Job {
        self.jobs.get(&job_id.0).cloned().unwrap_or_else(|| env::panic_str("No such job"))
    }

    fn open_job(&mut self, client: AccountId, token: Option<AccountId>, deposit: u128, j: NewJob) -> U64 {
        require!(!j.milestones.is_empty() && j.milestones.len() <= MAX_MILESTONES, "1 to 10 milestones");
        require!(j.freelancer != client, "Client and freelancer must differ");
        require!(j.title.len() <= 120, "Title too long");
        require!(j.criteria.min_overall <= 100 && j.criteria.min_accessibility <= 100 && j.criteria.min_mobile <= 100 && j.criteria.min_seo <= 100, "Scores are 0-100");
        let total: u128 = j.milestones.iter().map(|m| { require!(m.amount.0 > 0, "Milestone amounts must be positive"); m.amount.0 }).sum();
        require!(deposit == total, format!("Attach exactly the milestone total: {}", total));
        let id = self.next_id;
        self.next_id += 1;
        let now = env::block_timestamp();
        let job = Job {
            id: U64(id),
            client: client.clone(),
            freelancer: j.freelancer.clone(),
            title: j.title,
            token: token.clone(),
            criteria: j.criteria,
            milestones: j.milestones.into_iter().map(|m| Milestone { title: m.title.chars().take(80).collect(), amount: m.amount, status: MilestoneStatus::Open, submitted_url: None, attempts: 0 }).collect(),
            deadline: U64(now + j.deadline_secs.saturating_mul(1_000_000_000)),
            reports: vec![],
            created_at: U64(now),
        };
        log_event("create_job", serde_json::json!({"job_id": U64(id), "client": client, "freelancer": j.freelancer, "token": token, "amount": U128(total)}));
        self.jobs.insert(id, job);
        U64(id)
    }

    /// Pays a milestone to the job's freelancer. Recipient and amount come from state only.
    fn pay(&mut self, job: &mut Job, milestone: u8, reason: &str) -> Promise {
        let m = &mut job.milestones[milestone as usize];
        m.status = MilestoneStatus::Paying;
        let amount = m.amount.0;
        log_event("release", serde_json::json!({"job_id": job.id, "milestone": milestone, "to": job.freelancer, "amount": U128(amount), "reason": reason}));
        self.transfer(&job.token, job.freelancer.clone(), amount).then(
            Promise::new(env::current_account_id()).function_call(
                "on_payout".to_string(),
                serde_json::to_vec(&serde_json::json!({"job_id": job.id, "milestone": milestone})).unwrap(),
                NearToken::from_near(0),
                GAS_CALLBACK,
            ),
        )
    }

    fn transfer(&self, token: &Option<AccountId>, to: AccountId, amount: u128) -> Promise {
        match token {
            None => Promise::new(to).transfer(NearToken::from_yoctonear(amount)),
            Some(t) => Promise::new(t.clone()).function_call(
                "ft_transfer".to_string(),
                serde_json::to_vec(&serde_json::json!({"receiver_id": to, "amount": U128(amount), "memo": "Milestone Vault payout"})).unwrap(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn ctx(who: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who)).current_account_id(acc("vault.testnet")).attached_deposit(NearToken::from_yoctonear(deposit)).build());
    }
    fn criteria() -> Criteria {
        Criteria { min_overall: 75, min_accessibility: 90, min_mobile: 90, min_seo: 80, max_broken_links: 0, forbid_malicious_scripts: true }
    }
    fn setup() -> Contract {
        ctx("owner.testnet", 0);
        let mut c = Contract::new(acc("owner.testnet"), acc("auditor.testnet"));
        ctx("client.testnet", 300);
        c.create_job(NewJob {
            freelancer: acc("dev.testnet"),
            title: "Coffee shop site".into(),
            criteria: criteria(),
            milestones: vec![NewMilestone { title: "Landing page".into(), amount: U128(100) }, NewMilestone { title: "Menu".into(), amount: U128(200) }],
            deadline_secs: 3600,
        });
        c
    }
    fn hash() -> String { "a".repeat(64) }

    #[test]
    fn full_flow_pass_pays_freelancer() {
        let mut c = setup();
        ctx("dev.testnet", 0);
        c.submit(U64(0), 0, "https://example.com".into());
        ctx("auditor.testnet", 0);
        let _ = c.report(U64(0), 0, true, 92, hash(), "ok".into());
        assert_eq!(c.get_job(U64(0)).unwrap().milestones[0].status, MilestoneStatus::Paying);
    }

    #[test]
    fn fail_marks_rejected_and_allows_resubmit() {
        let mut c = setup();
        ctx("dev.testnet", 0);
        c.submit(U64(0), 0, "https://example.com".into());
        ctx("auditor.testnet", 0);
        let _ = c.report(U64(0), 0, false, 40, hash(), "mobile broken".into());
        assert_eq!(c.get_job(U64(0)).unwrap().milestones[0].status, MilestoneStatus::Rejected);
        ctx("dev.testnet", 0);
        c.submit(U64(0), 0, "https://example.com/v2".into());
        assert_eq!(c.get_job(U64(0)).unwrap().milestones[0].attempts, 2);
    }

    #[test]
    #[should_panic(expected = "Attach exactly the milestone total")]
    fn wrong_deposit_rejected() {
        ctx("owner.testnet", 0);
        let mut c = Contract::new(acc("owner.testnet"), acc("auditor.testnet"));
        ctx("client.testnet", 5);
        c.create_job(NewJob { freelancer: acc("dev.testnet"), title: "x".into(), criteria: criteria(), milestones: vec![NewMilestone { title: "a".into(), amount: U128(10) }], deadline_secs: 1 });
    }

    #[test]
    #[should_panic(expected = "Only the auditor can report")]
    fn stranger_cannot_report() {
        let mut c = setup();
        ctx("dev.testnet", 0);
        c.submit(U64(0), 0, "https://example.com".into());
        let _ = c.report(U64(0), 0, true, 100, hash(), "I approve myself".into());
    }

    #[test]
    #[should_panic(expected = "Milestone is not waiting for an audit")]
    fn auditor_cannot_pay_unsubmitted_milestone() {
        let mut c = setup();
        ctx("auditor.testnet", 0);
        let _ = c.report(U64(0), 1, true, 100, hash(), "pay it".into());
    }

    #[test]
    #[should_panic(expected = "Only the owner can change the auditor")]
    fn auditor_cannot_replace_itself() {
        let mut c = setup();
        ctx("auditor.testnet", 0);
        c.set_auditor(acc("evil.testnet"));
    }

    #[test]
    #[should_panic(expected = "The deadline has not passed yet")]
    fn refund_waits_for_deadline() {
        let mut c = setup();
        ctx("client.testnet", 0);
        let _ = c.refund(U64(0));
    }

    #[test]
    fn pending_audits_lists_submitted() {
        let mut c = setup();
        ctx("dev.testnet", 0);
        c.submit(U64(0), 1, "https://example.com/menu".into());
        assert_eq!(c.get_pending_audits(), vec![(U64(0), 1, "https://example.com/menu".to_string())]);
    }
}
