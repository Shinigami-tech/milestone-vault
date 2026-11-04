//! Milestone Vault
//!
//! An escrow for website work. A client locks the payment for each milestone in this
//! contract. When the freelancer submits a milestone, independent AI auditors open the
//! site in sandboxes and report the result. A milestone that passes the agreed checks is
//! paid to the freelancer after a short challenge window.
//!
//! The safety model is written into the contract, not into a prompt:
//! * Auditors can only call `report` (and the permissionless `release`). They never choose
//!   who gets paid or how much: the recipient is always the job's freelancer and the amount
//!   is always that milestone's.
//! * A payout needs a QUORUM of independent auditors (e.g. 2 of 2). One fooled or hijacked
//!   auditor cannot pay out alone, and any auditor can block a bad milestone.
//! * Each auditor signs with a function-call access key scoped to this contract, so it
//!   cannot transfer funds, deploy code or add keys, even if the agent is fooled.
//! * After a pass, the client has a challenge window to dispute before money moves;
//!   disputes go to the arbiter. The client can always approve by hand, or take back
//!   unpaid milestones after the deadline.
//! * Auditors are paid a small per-audit fee from a budget the client prepaid: an agent
//!   that earns for honest work, capped by the contract.
//!
//! Payments are native NEAR or any NEP-141 token (for example USDC), chosen per job.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near,
    require, serde_json,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MAX_MILESTONES: usize = 10;
const MAX_REPORTS: usize = 40;
const MAX_AUDITORS: usize = 7;
const MAX_CHALLENGE_SECS: u64 = 30 * 24 * 3600;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum MilestoneStatus {
    /// Funded, waiting for the freelancer.
    Open,
    /// The freelancer submitted a URL; waiting for the auditors.
    Submitted,
    /// The auditors found problems; the freelancer can fix them and submit again.
    Rejected,
    /// A quorum of auditors passed it; paid when the challenge window ends.
    Approved,
    /// The client disputed an approval inside the window; the arbiter decides.
    Disputed,
    /// A payout is on its way (transfer in flight).
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

/// One auditor's verdict on the current submission of a milestone.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Vote {
    pub auditor: AccountId,
    pub passed: bool,
    pub overall: u8,
    pub evidence_hash: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Milestone {
    pub title: String,
    pub amount: U128,
    pub status: MilestoneStatus,
    pub submitted_url: Option<String>,
    pub attempts: u8,
    /// Votes on the current attempt (cleared on every new submission).
    pub votes: Vec<Vote>,
    /// When an Approved milestone may be released (ns).
    pub release_at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Report {
    pub milestone: u8,
    pub auditor: AccountId,
    pub url: String,
    pub passed: bool,
    pub overall: u8,
    /// sha256 of the full audit report, so anyone can check the published evidence.
    pub evidence_hash: String,
    /// sha256 of the signed AI attestation (NEAR AI Cloud TEE), if the note was written by one.
    pub attestation_hash: Option<String>,
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
    /// Seconds between a quorum pass and the payout, during which the client can dispute.
    pub challenge_secs: u64,
    /// Paid to each auditor per report, from `audit_budget`.
    pub audit_fee: U128,
    pub audit_budget: U128,
    pub fees_paid: U128,
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
    /// Challenge window in seconds (0 = pay as soon as the quorum passes).
    pub challenge_secs: Option<u64>,
    /// Per-report fee for each auditor; `audit_budget` must be attached on top of the milestones.
    pub audit_fee: Option<U128>,
    pub audit_budget: Option<U128>,
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
    /// Arbiter for disputes and the only account that can change the auditor set.
    owner: AccountId,
    auditors: Vec<AccountId>,
    quorum: u8,
    next_id: u64,
    jobs: IterableMap<u64, Job>,
}

fn log_event(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({"standard": "milestone-vault", "version": "2.0.0", "event": event, "data": [data]})
    ));
}

fn is_sha256(h: &str) -> bool { h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()) }

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, auditors: Vec<AccountId>, quorum: u8) -> Self {
        Self::check_auditors(&auditors, quorum);
        Self { owner, auditors, quorum, next_id: 0, jobs: IterableMap::new(b"j") }
    }

    // ---------------------------------------------------------------- client

    /// Create a job paid in native NEAR. Attach the milestone sum plus the audit budget.
    #[payable]
    pub fn create_job(&mut self, job: NewJob) -> U64 {
        let deposit = env::attached_deposit().as_yoctonear();
        self.open_job(env::predecessor_account_id(), None, deposit, job)
    }

    /// NEP-141 receiver: create a job paid in a token, e.g. USDC.
    /// `msg` is the JSON of `NewJob`; the amount must equal the milestone sum plus the audit budget.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let job: NewJob = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be a NewJob JSON"));
        self.open_job(sender_id, Some(token), amount.0, job);
        PromiseOrValue::Value(U128(0))
    }

    /// The client can always approve a milestone by hand (also during the challenge window).
    pub fn approve(&mut self, job_id: U64, milestone: u8) -> Promise {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.client, "Only the client can approve by hand");
        let m = self.milestone(&job, milestone);
        require!(
            matches!(m.status, MilestoneStatus::Open | MilestoneStatus::Submitted | MilestoneStatus::Rejected | MilestoneStatus::Approved | MilestoneStatus::Disputed),
            "Milestone is not payable"
        );
        let p = self.pay(&mut job, milestone, "client_approved");
        self.jobs.insert(job_id.0, job);
        p
    }

    /// Inside the challenge window the client can stop an approved payout; the arbiter decides.
    pub fn dispute(&mut self, job_id: U64, milestone: u8, reason: String) {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.client, "Only the client can dispute");
        let m = job.milestones.get_mut(milestone as usize).unwrap_or_else(|| env::panic_str("No such milestone"));
        require!(m.status == MilestoneStatus::Approved, "Only an approved milestone can be disputed");
        require!(env::block_timestamp() < m.release_at.0, "The challenge window has closed");
        m.status = MilestoneStatus::Disputed;
        let reason: String = reason.chars().take(280).collect();
        log_event("dispute", serde_json::json!({"job_id": job_id, "milestone": milestone, "reason": reason}));
        self.jobs.insert(job_id.0, job);
    }

    /// After the deadline the client takes back every milestone that was not paid, plus the
    /// unused audit budget.
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
        total += job.audit_budget.0;
        job.audit_budget = U128(0);
        require!(total > 0, "Nothing to refund");
        log_event("refund", serde_json::json!({"job_id": job_id, "client": job.client, "amount": U128(total)}));
        let p = self.transfer(&job.token, job.client.clone(), total);
        self.jobs.insert(job_id.0, job);
        p
    }

    // ------------------------------------------------------------ freelancer

    /// The freelancer hands in a milestone: the URL the auditors should examine.
    /// Works as a NEP-366 meta transaction, so a relayer can pay the gas.
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
        m.votes.clear();
        log_event("submit", serde_json::json!({"job_id": job_id, "milestone": milestone, "url": url}));
        self.jobs.insert(job_id.0, job);
    }

    // --------------------------------------------------------------- auditors

    /// The method an auditor's key exists for. It records one auditor's verdict. A quorum of
    /// passes approves the milestone (paid after the challenge window); enough fails reject it.
    /// The auditor cannot pick the recipient or the amount, and cannot vote twice.
    pub fn report(
        &mut self,
        job_id: U64,
        milestone: u8,
        passed: bool,
        overall: u8,
        evidence_hash: String,
        summary: String,
        attestation_hash: Option<String>,
    ) -> PromiseOrValue<()> {
        let auditor = env::predecessor_account_id();
        require!(self.auditors.contains(&auditor), "Only an auditor can report");
        require!(is_sha256(&evidence_hash), "evidence_hash must be sha256 hex");
        if let Some(a) = &attestation_hash { require!(is_sha256(a), "attestation_hash must be sha256 hex"); }
        let mut job = self.job(job_id);
        let quorum = self.quorum as usize;
        let n = self.auditors.len();
        let now = env::block_timestamp();
        let (url, passes, fails) = {
            let m = job.milestones.get_mut(milestone as usize).unwrap_or_else(|| env::panic_str("No such milestone"));
            require!(m.status == MilestoneStatus::Submitted, "Milestone is not waiting for an audit");
            require!(!m.votes.iter().any(|v| v.auditor == auditor), "This auditor already reported on this submission");
            m.votes.push(Vote { auditor: auditor.clone(), passed, overall, evidence_hash: evidence_hash.clone() });
            let passes = m.votes.iter().filter(|v| v.passed).count();
            (m.submitted_url.clone().unwrap_or_default(), passes, m.votes.len() - passes)
        };
        let summary: String = summary.chars().take(280).collect();
        if job.reports.len() >= MAX_REPORTS { job.reports.remove(0); }
        job.reports.push(Report { milestone, auditor: auditor.clone(), url: url.clone(), passed, overall, evidence_hash: evidence_hash.clone(), attestation_hash: attestation_hash.clone(), summary, at: U64(now) });
        log_event("report", serde_json::json!({"job_id": job_id, "milestone": milestone, "auditor": auditor, "passed": passed, "overall": overall, "evidence_hash": evidence_hash, "attestation_hash": attestation_hash, "url": url, "votes": format!("{}/{}", passes, quorum)}));

        // The auditor earns its fee for an honest day's work, capped by the prepaid budget.
        let fee = job.audit_fee.0;
        let fee_promise = if fee > 0 && job.audit_budget.0 >= fee {
            job.audit_budget = U128(job.audit_budget.0 - fee);
            job.fees_paid = U128(job.fees_paid.0 + fee);
            log_event("audit_fee", serde_json::json!({"job_id": job_id, "auditor": auditor, "amount": U128(fee)}));
            Some(self.transfer(&job.token, auditor.clone(), fee))
        } else { None };

        let mut result = PromiseOrValue::Value(());
        if passes >= quorum {
            let m = &mut job.milestones[milestone as usize];
            m.status = MilestoneStatus::Approved;
            m.release_at = U64(now + job.challenge_secs.saturating_mul(1_000_000_000));
            log_event("approved", serde_json::json!({"job_id": job_id, "milestone": milestone, "release_at": m.release_at}));
            if job.challenge_secs == 0 {
                result = PromiseOrValue::Promise(self.pay(&mut job, milestone, "audit_passed"));
            }
        } else if fails > n - quorum {
            job.milestones[milestone as usize].status = MilestoneStatus::Rejected;
            log_event("rejected", serde_json::json!({"job_id": job_id, "milestone": milestone}));
        }
        self.jobs.insert(job_id.0, job);
        match (result, fee_promise) {
            (PromiseOrValue::Promise(p), Some(f)) => PromiseOrValue::Promise(p.and(f)),
            (PromiseOrValue::Promise(p), None) => PromiseOrValue::Promise(p),
            (_, Some(f)) => PromiseOrValue::Promise(f),
            (v, None) => v,
        }
    }

    /// Permissionless: once the challenge window is over, anyone can trigger the payout of an
    /// approved milestone. The money can still only go to the job's freelancer.
    pub fn release(&mut self, job_id: U64, milestone: u8) -> Promise {
        let mut job = self.job(job_id);
        let m = self.milestone(&job, milestone);
        require!(m.status == MilestoneStatus::Approved, "Milestone is not approved");
        require!(env::block_timestamp() >= m.release_at.0, "The challenge window is still open");
        let p = self.pay(&mut job, milestone, "audit_passed");
        self.jobs.insert(job_id.0, job);
        p
    }

    // ----------------------------------------------------------------- owner

    /// The arbiter settles a dispute: pay the freelancer, or send the milestone back for fixes.
    pub fn resolve(&mut self, job_id: U64, milestone: u8, pay: bool) -> PromiseOrValue<()> {
        require!(env::predecessor_account_id() == self.owner, "Only the arbiter can resolve disputes");
        let mut job = self.job(job_id);
        require!(self.milestone(&job, milestone).status == MilestoneStatus::Disputed, "Milestone is not disputed");
        log_event("resolve", serde_json::json!({"job_id": job_id, "milestone": milestone, "pay": pay}));
        let r = if pay { PromiseOrValue::Promise(self.pay(&mut job, milestone, "arbiter")) } else {
            let m = &mut job.milestones[milestone as usize];
            m.status = MilestoneStatus::Rejected;
            m.votes.clear();
            PromiseOrValue::Value(())
        };
        self.jobs.insert(job_id.0, job);
        r
    }

    pub fn set_auditors(&mut self, auditors: Vec<AccountId>, quorum: u8) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can change the auditors");
        Self::check_auditors(&auditors, quorum);
        log_event("set_auditors", serde_json::json!({"auditors": auditors, "quorum": quorum}));
        self.auditors = auditors;
        self.quorum = quorum;
    }

    // ----------------------------------------------------------------- views

    pub fn get_job(&self, job_id: U64) -> Option<Job> { self.jobs.get(&job_id.0).cloned() }

    pub fn get_jobs(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Job> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(100) as usize;
        self.jobs.values().skip(from).take(limit).cloned().collect()
    }

    /// Milestones waiting for an audit: (job_id, milestone, url). With `auditor`, only the ones
    /// that auditor has not reported on yet.
    pub fn get_pending_audits(&self, auditor: Option<AccountId>) -> Vec<(U64, u8, String)> {
        let mut out = vec![];
        for job in self.jobs.values() {
            for (i, m) in job.milestones.iter().enumerate() {
                if m.status == MilestoneStatus::Submitted && auditor.as_ref().is_none_or(|a| !m.votes.iter().any(|v| &v.auditor == a)) {
                    out.push((job.id, i as u8, m.submitted_url.clone().unwrap_or_default()));
                }
            }
        }
        out
    }

    /// Approved milestones whose challenge window is over: (job_id, milestone).
    pub fn get_releasable(&self) -> Vec<(U64, u8)> {
        let now = env::block_timestamp();
        let mut out = vec![];
        for job in self.jobs.values() {
            for (i, m) in job.milestones.iter().enumerate() {
                if m.status == MilestoneStatus::Approved && now >= m.release_at.0 { out.push((job.id, i as u8)); }
            }
        }
        out
    }

    pub fn get_config(&self) -> serde_json::Value {
        serde_json::json!({"owner": self.owner, "auditors": self.auditors, "quorum": self.quorum, "jobs": self.next_id, "version": "2.0.0"})
    }

    // -------------------------------------------------------------- callback

    #[private]
    pub fn on_payout(&mut self, job_id: U64, milestone: u8) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        let mut job = self.job(job_id);
        let m = &mut job.milestones[milestone as usize];
        // A failed token transfer (e.g. freelancer not registered with the token) puts the
        // milestone back as approved so it can be released again; no funds are lost.
        m.status = if ok { MilestoneStatus::Released } else { MilestoneStatus::Approved };
        log_event(if ok { "payout" } else { "payout_failed" }, serde_json::json!({"job_id": job_id, "milestone": milestone}));
        // When every milestone is settled, the unused audit budget goes back to the client.
        let settled = job.milestones.iter().all(|m| matches!(m.status, MilestoneStatus::Released | MilestoneStatus::Refunded));
        if ok && settled && job.audit_budget.0 > 0 {
            let left = job.audit_budget.0;
            job.audit_budget = U128(0);
            log_event("budget_returned", serde_json::json!({"job_id": job_id, "amount": U128(left)}));
            self.transfer(&job.token, job.client.clone(), left).detach();
        }
        self.jobs.insert(job_id.0, job);
        ok
    }

    // -------------------------------------------------------------- internal

    fn check_auditors(auditors: &[AccountId], quorum: u8) {
        require!(!auditors.is_empty() && auditors.len() <= MAX_AUDITORS, "1 to 7 auditors");
        require!(quorum >= 1 && (quorum as usize) <= auditors.len(), "Quorum must be between 1 and the number of auditors");
        let mut seen = auditors.to_vec(); seen.sort(); seen.dedup();
        require!(seen.len() == auditors.len(), "Auditors must be distinct");
    }

    fn job(&self, job_id: U64) -> Job {
        self.jobs.get(&job_id.0).cloned().unwrap_or_else(|| env::panic_str("No such job"))
    }

    fn milestone<'a>(&self, job: &'a Job, milestone: u8) -> &'a Milestone {
        job.milestones.get(milestone as usize).unwrap_or_else(|| env::panic_str("No such milestone"))
    }

    fn open_job(&mut self, client: AccountId, token: Option<AccountId>, deposit: u128, j: NewJob) -> U64 {
        require!(!j.milestones.is_empty() && j.milestones.len() <= MAX_MILESTONES, "1 to 10 milestones");
        require!(j.freelancer != client, "Client and freelancer must differ");
        require!(!self.auditors.contains(&j.freelancer) && !self.auditors.contains(&client), "Auditors cannot be a party to the job");
        require!(j.title.len() <= 120, "Title too long");
        require!(j.criteria.min_overall <= 100 && j.criteria.min_accessibility <= 100 && j.criteria.min_mobile <= 100 && j.criteria.min_seo <= 100, "Scores are 0-100");
        let challenge_secs = j.challenge_secs.unwrap_or(0);
        require!(challenge_secs <= MAX_CHALLENGE_SECS, "Challenge window is at most 30 days");
        let total: u128 = j.milestones.iter().map(|m| { require!(m.amount.0 > 0, "Milestone amounts must be positive"); m.amount.0 }).sum();
        let budget = j.audit_budget.map(|b| b.0).unwrap_or(0);
        let fee = j.audit_fee.map(|f| f.0).unwrap_or(0);
        require!(fee == 0 || budget >= fee, "The audit budget must cover at least one fee");
        require!(deposit == total + budget, format!("Attach exactly the milestone total plus the audit budget: {}", total + budget));
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
            milestones: j.milestones.into_iter().map(|m| Milestone { title: m.title.chars().take(80).collect(), amount: m.amount, status: MilestoneStatus::Open, submitted_url: None, attempts: 0, votes: vec![], release_at: U64(0) }).collect(),
            deadline: U64(now + j.deadline_secs.saturating_mul(1_000_000_000)),
            challenge_secs,
            audit_fee: U128(fee),
            audit_budget: U128(budget),
            fees_paid: U128(0),
            reports: vec![],
            created_at: U64(now),
        };
        log_event("create_job", serde_json::json!({"job_id": U64(id), "client": client, "freelancer": j.freelancer, "token": token, "amount": U128(total), "audit_budget": U128(budget), "challenge_secs": challenge_secs}));
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
    fn ctx_at(who: &str, deposit: u128, ts: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who)).current_account_id(acc("vault.testnet")).attached_deposit(NearToken::from_yoctonear(deposit)).block_timestamp(ts).build());
    }
    fn ctx(who: &str, deposit: u128) { ctx_at(who, deposit, 1_000); }
    fn criteria() -> Criteria {
        Criteria { min_overall: 75, min_accessibility: 90, min_mobile: 90, min_seo: 80, max_broken_links: 0, forbid_malicious_scripts: true }
    }
    fn job(challenge: u64, fee: u128, budget: u128) -> NewJob {
        NewJob {
            freelancer: acc("dev.testnet"),
            title: "Coffee shop site".into(),
            criteria: criteria(),
            milestones: vec![NewMilestone { title: "Landing page".into(), amount: U128(100) }, NewMilestone { title: "Menu".into(), amount: U128(200) }],
            deadline_secs: 3600,
            challenge_secs: Some(challenge),
            audit_fee: Some(U128(fee)),
            audit_budget: Some(U128(budget)),
        }
    }
    /// 2-of-2 auditors, no challenge window, no fees.
    fn setup_with(quorum: u8, challenge: u64, fee: u128, budget: u128) -> Contract {
        ctx("owner.testnet", 0);
        let mut c = Contract::new(acc("owner.testnet"), vec![acc("a1.testnet"), acc("a2.testnet")], quorum);
        ctx("client.testnet", 300 + budget);
        c.create_job(job(challenge, fee, budget));
        c
    }
    fn setup() -> Contract { setup_with(2, 0, 0, 0) }
    fn hash() -> String { "a".repeat(64) }
    fn submit(c: &mut Contract, m: u8) { ctx("dev.testnet", 0); c.submit(U64(0), m, "https://example.com".into()); }
    fn vote(c: &mut Contract, who: &str, m: u8, pass: bool) { ctx(who, 0); let _ = c.report(U64(0), m, pass, if pass { 95 } else { 40 }, hash(), "note".into(), None); }
    fn status(c: &Contract, m: usize) -> MilestoneStatus { c.get_job(U64(0)).unwrap().milestones[m].status.clone() }

    #[test]
    fn quorum_pass_pays_freelancer() {
        let mut c = setup();
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, true);
        assert_eq!(status(&c, 0), MilestoneStatus::Submitted, "one auditor alone must not pay");
        vote(&mut c, "a2.testnet", 0, true);
        assert_eq!(status(&c, 0), MilestoneStatus::Paying);
    }

    #[test]
    fn one_hijacked_auditor_cannot_pay_alone() {
        let mut c = setup();
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, true);   // compromised: says pass
        vote(&mut c, "a2.testnet", 0, false);  // honest: says fail
        assert_eq!(status(&c, 0), MilestoneStatus::Rejected);
    }

    #[test]
    #[should_panic(expected = "already reported")]
    fn auditor_cannot_vote_twice() {
        let mut c = setup();
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, true);
        vote(&mut c, "a1.testnet", 0, true);
    }

    #[test]
    fn resubmission_clears_votes() {
        let mut c = setup_with(1, 0, 0, 0);
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, false);
        vote(&mut c, "a2.testnet", 0, false);
        assert_eq!(status(&c, 0), MilestoneStatus::Rejected);
        submit(&mut c, 0);
        let j = c.get_job(U64(0)).unwrap();
        assert!(j.milestones[0].votes.is_empty());
        assert_eq!(j.milestones[0].attempts, 2);
    }

    #[test]
    fn challenge_window_then_release() {
        let mut c = setup_with(2, 60, 0, 0);
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, true);
        vote(&mut c, "a2.testnet", 0, true);
        assert_eq!(status(&c, 0), MilestoneStatus::Approved);
        ctx_at("anyone.testnet", 0, 1_000 + 61 * 1_000_000_000);
        let _ = c.release(U64(0), 0);
        assert_eq!(status(&c, 0), MilestoneStatus::Paying);
    }

    #[test]
    #[should_panic(expected = "still open")]
    fn release_waits_for_window() {
        let mut c = setup_with(2, 60, 0, 0);
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, true);
        vote(&mut c, "a2.testnet", 0, true);
        ctx("anyone.testnet", 0);
        let _ = c.release(U64(0), 0);
    }

    #[test]
    fn client_dispute_goes_to_arbiter() {
        let mut c = setup_with(2, 60, 0, 0);
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, true);
        vote(&mut c, "a2.testnet", 0, true);
        ctx("client.testnet", 0);
        c.dispute(U64(0), 0, "Menu prices are wrong".into());
        assert_eq!(status(&c, 0), MilestoneStatus::Disputed);
        ctx("owner.testnet", 0);
        let _ = c.resolve(U64(0), 0, false);
        assert_eq!(status(&c, 0), MilestoneStatus::Rejected);
    }

    #[test]
    #[should_panic(expected = "Only the arbiter")]
    fn auditor_cannot_resolve_disputes() {
        let mut c = setup_with(2, 60, 0, 0);
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, true);
        vote(&mut c, "a2.testnet", 0, true);
        ctx("client.testnet", 0);
        c.dispute(U64(0), 0, "no".into());
        ctx("a1.testnet", 0);
        let _ = c.resolve(U64(0), 0, true);
    }

    #[test]
    fn auditors_earn_capped_fees() {
        let mut c = setup_with(2, 0, 5, 12);
        submit(&mut c, 0);
        vote(&mut c, "a1.testnet", 0, true);
        vote(&mut c, "a2.testnet", 0, true);
        let j = c.get_job(U64(0)).unwrap();
        assert_eq!(j.fees_paid.0, 10);
        assert_eq!(j.audit_budget.0, 2);
        submit(&mut c, 1);
        vote(&mut c, "a1.testnet", 1, true); // budget 2 < fee 5: no fee, verdict still recorded
        assert_eq!(c.get_job(U64(0)).unwrap().fees_paid.0, 10);
    }

    #[test]
    #[should_panic(expected = "Attach exactly the milestone total plus the audit budget")]
    fn wrong_deposit_rejected() {
        ctx("owner.testnet", 0);
        let mut c = Contract::new(acc("owner.testnet"), vec![acc("a1.testnet")], 1);
        ctx("client.testnet", 300);
        c.create_job(job(0, 1, 10));
    }

    #[test]
    #[should_panic(expected = "Only an auditor can report")]
    fn stranger_cannot_report() {
        let mut c = setup();
        submit(&mut c, 0);
        vote(&mut c, "dev.testnet", 0, true);
    }

    #[test]
    #[should_panic(expected = "Milestone is not waiting for an audit")]
    fn auditor_cannot_pay_unsubmitted_milestone() {
        let mut c = setup();
        vote(&mut c, "a1.testnet", 1, true);
    }

    #[test]
    #[should_panic(expected = "Only the owner can change the auditors")]
    fn auditor_cannot_replace_the_set() {
        let mut c = setup();
        ctx("a1.testnet", 0);
        c.set_auditors(vec![acc("evil.testnet")], 1);
    }

    #[test]
    #[should_panic(expected = "Auditors cannot be a party to the job")]
    fn auditor_cannot_be_the_freelancer() {
        ctx("owner.testnet", 0);
        let mut c = Contract::new(acc("owner.testnet"), vec![acc("dev.testnet")], 1);
        ctx("client.testnet", 300);
        c.create_job(job(0, 0, 0));
    }

    #[test]
    #[should_panic(expected = "The deadline has not passed yet")]
    fn refund_waits_for_deadline() {
        let mut c = setup();
        ctx("client.testnet", 0);
        let _ = c.refund(U64(0));
    }

    #[test]
    fn pending_audits_per_auditor() {
        let mut c = setup();
        submit(&mut c, 1);
        vote(&mut c, "a1.testnet", 1, true);
        assert!(c.get_pending_audits(Some(acc("a1.testnet"))).is_empty());
        assert_eq!(c.get_pending_audits(Some(acc("a2.testnet"))), vec![(U64(0), 1, "https://example.com".to_string())]);
    }
}
