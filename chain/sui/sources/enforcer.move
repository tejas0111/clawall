module constraint_layer::enforcer {
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::tx_context::{Self, TxContext};
    use sui::bag::{Self, Bag};
    use std::vector;
    use std::type_name::{Self, TypeName};

    const E_WRONG_RECIPIENT: u64 = 2;
    const E_TOKEN_EXPIRED: u64 = 3;
    const E_INVALID_CLOCK: u64 = 4;
    const E_GLOBAL_FROZEN: u64 = 8;
    const E_WRONG_COIN_TYPE: u64 = 11;
    const E_INSUFFICIENT_VAULT_BALANCE: u64 = 12;

    public struct GuardCap has key, store { id: UID }
    public struct PolicyAdminCap has key, store { id: UID }

    public struct GlobalFreeze has key {
        id: UID,
        frozen: bool,
        reason: vector<u8>,
        updated_at_ms: u64,
        updated_by: address,
    }

    public struct GlobalFreezeChanged has copy, drop {
        freeze_id: ID,
        frozen: bool,
        reason: vector<u8>,
        updated_at_ms: u64,
        updated_by: address,
    }

    // --- Master Vault Logic (Multi-Coin) ---
    public struct Vault has key {
        id: UID,
        balances: Bag,
    }

    public fun create_vault(ctx: &mut TxContext) {
        transfer::share_object(Vault {
            id: object::new(ctx),
            balances: bag::new(ctx),
        });
    }

    public fun deposit<T>(vault: &mut Vault, payment: Coin<T>) {
        let t_name = type_name::get<T>();
        if (!bag::contains(&vault.balances, t_name)) {
            bag::add(&mut vault.balances, t_name, balance::zero<T>());
        };
        let b = bag::borrow_mut<TypeName, Balance<T>>(&mut vault.balances, t_name);
        coin::put(b, payment);
    }

    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        transfer::transfer(GuardCap { id: object::new(ctx) }, sender);
        transfer::transfer(PolicyAdminCap { id: object::new(ctx) }, sender);
        
        transfer::share_object(GlobalFreeze {
            id: object::new(ctx),
            frozen: false,
            reason: vector::empty<u8>(),
            updated_at_ms: 0,
            updated_by: sender,
        });
    }

    public struct TransferConstraint has key {
        id: UID,
        max_amount: u64,
        allowed_recipient: address,
        coin_type: vector<u8>,
        expiry_ms: u64,
        nonce: vector<u8>,
        walrus_audit_blob_id: vector<u8>,
    }

    public struct TransferExecuted has copy, drop {
        constraint_id: ID,
        amount: u64,
        recipient: address,
        coin_type: vector<u8>,
        timestamp_ms: u64,
        audit_blob_id: vector<u8>,
    }

    public struct PolicyAnchor has key {
        id: UID,
        current_hash: vector<u8>,
        updated_at_ms: u64,
        updated_by: address,
    }

    public fun set_global_freeze(
        _cap: &PolicyAdminCap,
        freeze_state: &mut GlobalFreeze,
        frozen: bool,
        reason: vector<u8>,
        clock: &Clock,
        ctx: &TxContext
    ) {
        assert!(object::id(clock) == object::id_from_address(@0x6), E_INVALID_CLOCK);
        let now = clock::timestamp_ms(clock);
        let sender = tx_context::sender(ctx);
        freeze_state.frozen = frozen;
        freeze_state.reason = reason;
        freeze_state.updated_at_ms = now;
        freeze_state.updated_by = sender;

        event::emit(GlobalFreezeChanged {
            freeze_id: object::uid_to_inner(&freeze_state.id),
            frozen,
            reason: copy freeze_state.reason,
            updated_at_ms: now,
            updated_by: sender,
        });
    }

    public fun mint_constraint(
        _cap: &GuardCap,
        max_amount: u64,
        allowed_recipient: address,
        coin_type: vector<u8>,
        expiry_ms: u64,
        nonce: vector<u8>,
        walrus_audit_blob_id: vector<u8>,
        ctx: &mut TxContext
    ): TransferConstraint {
        TransferConstraint {
            id: object::new(ctx),
            max_amount,
            allowed_recipient,
            coin_type,
            expiry_ms,
            nonce,
            walrus_audit_blob_id,
        }
    }

    public fun execute_transfer_from_vault<T>(
        constraint: TransferConstraint,
        vault: &mut Vault,
        recipient: address,
        freeze_state: &GlobalFreeze,
        clock: &Clock,
        expected_coin_type: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(object::id(clock) == object::id_from_address(@0x6), E_INVALID_CLOCK);
        assert!(!freeze_state.frozen, E_GLOBAL_FROZEN);

        let TransferConstraint {
            id,
            max_amount,
            allowed_recipient,
            coin_type,
            expiry_ms,
            nonce: _,
            walrus_audit_blob_id,
        } = constraint;

        let now = clock::timestamp_ms(clock);
        assert!(now < expiry_ms, E_TOKEN_EXPIRED);
        assert!(coin_type == expected_coin_type, E_WRONG_COIN_TYPE);
        assert!(recipient == allowed_recipient, E_WRONG_RECIPIENT);

        let t_name = type_name::get<T>();
        assert!(bag::contains(&vault.balances, t_name), E_INSUFFICIENT_VAULT_BALANCE);
        let b = bag::borrow_mut<TypeName, Balance<T>>(&mut vault.balances, t_name);
        assert!(balance::value(b) >= max_amount, E_INSUFFICIENT_VAULT_BALANCE);

        let coin_to_send = coin::from_balance(balance::split(b, max_amount), ctx);
        transfer::public_transfer(coin_to_send, recipient);

        event::emit(TransferExecuted {
            constraint_id: object::uid_to_inner(&id),
            amount: max_amount,
            recipient,
            coin_type,
            timestamp_ms: now,
            audit_blob_id: walrus_audit_blob_id,
        });

        object::delete(id);
    }

    public fun mint_policy_anchor(
        _cap: &PolicyAdminCap,
        policy_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let anchor = PolicyAnchor {
            id: object::new(ctx),
            current_hash: policy_hash,
            updated_at_ms: clock::timestamp_ms(clock),
            updated_by: tx_context::sender(ctx),
        };
        transfer::transfer(anchor, tx_context::sender(ctx));
    }

    public fun set_policy_hash(
        _cap: &PolicyAdminCap,
        anchor: &mut PolicyAnchor,
        policy_hash: vector<u8>,
        clock: &Clock,
        ctx: &TxContext
    ) {
        anchor.current_hash = policy_hash;
        anchor.updated_at_ms = clock::timestamp_ms(clock);
        anchor.updated_by = tx_context::sender(ctx);
    }
}
