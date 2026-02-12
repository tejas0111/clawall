module constraint_layer::enforcer {
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::tx_context;

    const E_AMOUNT_EXCEEDED: u64 = 1;
    const E_WRONG_RECIPIENT: u64 = 2;
    const E_TOKEN_EXPIRED: u64 = 3;
    const E_INVALID_CLOCK: u64 = 4;

    public struct GuardCap has key {
        id: UID,
    }

    fun init(ctx: &mut tx_context::TxContext) {
        transfer::transfer(
            GuardCap { id: object::new(ctx) },
            tx_context::sender(ctx)
        );
    }

    public struct TransferConstraint has key {
        id: UID,
        max_amount: u64,
        allowed_recipient: address,
        expiry_ms: u64,
        nonce: vector<u8>,
        proposal_blob_id: vector<u8>,
    }

    public struct TransferExecuted has copy, drop {
        constraint_id: ID,
        amount: u64,
        recipient: address,
        timestamp_ms: u64,
        success: bool,
        audit_blob_id: vector<u8>,
    }

    public fun mint_constraint(
        _cap: &GuardCap,
        max_amount: u64,
        allowed_recipient: address,
        expiry_ms: u64,
        nonce: vector<u8>,
        proposal_blob_id: vector<u8>,
        ctx: &mut tx_context::TxContext
    ): TransferConstraint {
        TransferConstraint {
            id: object::new(ctx),
            max_amount,
            allowed_recipient,
            expiry_ms,
            nonce,
            proposal_blob_id,
        }
    }

    public fun execute_transfer(
        constraint: TransferConstraint,
        payment: Coin<SUI>,
        recipient: address,
        clock: &Clock,
        _ctx: &mut tx_context::TxContext
    ) {
        assert!(
            object::id(clock) == object::id_from_address(@0x6),
            E_INVALID_CLOCK
        );

        let TransferConstraint {
            id,
            max_amount,
            allowed_recipient,
            expiry_ms,
            nonce: _,
            proposal_blob_id,
        } = constraint;

        let now = clock::timestamp_ms(clock);

        assert!(now < expiry_ms, E_TOKEN_EXPIRED);

        let amount = coin::value(&payment);

        assert!(amount <= max_amount, E_AMOUNT_EXCEEDED);
        assert!(recipient == allowed_recipient, E_WRONG_RECIPIENT);

        transfer::public_transfer(payment, recipient);

        event::emit(TransferExecuted {
            constraint_id: object::uid_to_inner(&id),
            amount,
            recipient,
            timestamp_ms: now,
            success: true,
            audit_blob_id: proposal_blob_id,
        });

        object::delete(id);
    }
}

