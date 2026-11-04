//! tUSDC: a TESTNET-ONLY demo stablecoin (NEP-141, 6 decimals) so judges can try Milestone Vault's
//! stablecoin flow without a faucet. Anyone can mint up to 1,000 tUSDC per call. Not real money.
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

const MAX_MINT: u128 = 1_000_000_000; // 1,000 tUSDC (6 decimals)

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract { token: FungibleToken }

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self { Self { token: FungibleToken::new(b"t".to_vec()) } }

    /// Testnet faucet: mint up to 1,000 tUSDC to `account_id` (registers it if needed).
    #[payable]
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(amount.0 > 0 && amount.0 <= MAX_MINT, "Mint 0 < amount <= 1000 tUSDC");
        if !self.token.accounts.contains_key(&account_id) { self.token.internal_register_account(&account_id); }
        self.token.internal_deposit(&account_id, amount.0);
        near_contract_standards::fungible_token::events::FtMint { owner_id: &account_id, amount: amount, memo: Some("testnet faucet") }.emit();
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) { self.token.ft_transfer(receiver_id, amount, memo) }
    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> { self.token.ft_transfer_call(receiver_id, amount, memo, msg) }
    fn ft_total_supply(&self) -> U128 { self.token.ft_total_supply() }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 { self.token.ft_balance_of(account_id) }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance { self.token.storage_deposit(account_id, registration_only) }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance { self.token.storage_withdraw(amount) }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool { self.token.internal_storage_unregister(force).is_some() }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds { self.token.storage_balance_bounds() }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> { self.token.storage_balance_of(account_id) }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata { spec: FT_METADATA_SPEC.to_string(), name: "Testnet USDC (Milestone Vault demo)".into(), symbol: "tUSDC".into(), icon: None, reference: None, reference_hash: None, decimals: 6 }
    }
}
