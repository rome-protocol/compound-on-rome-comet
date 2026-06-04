// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

/**
 * USER-SIGNED SPL faucet that drops test tokens to the caller's OWN Phantom
 * wallet ATA — the synthetic-transient origin the Solana-native supply flow
 * pulls from (supply = wallet ATA -> synthetic ATA -> Comet; the synthetic
 * holds nothing at rest).
 *
 * Contrast with FaucetEgress (operator-driven): that uses HELPER.delegatecall,
 * so the SPL source is external_auth(msg.sender) = the operator EOA, and a
 * backend signs. This contract uses HELPER.call, so the precompile sees
 * msg.sender = THIS CONTRACT and the source is external_auth(address(this)) =
 * the faucet's OWN reserve. That makes the drop self-serve: the Solana-native
 * user's own DoTxUnsigned (msg.sender = their synthetic, outer Phantom signer
 * pays SOL) triggers it — no server key, no operator signature.
 *
 * Drop amount per mint is CONTRACT POLICY (set by admin), not caller-supplied,
 * so a single wallet can't drain the reserve; idempotent per (recipient, mint)
 * so each wallet drips once per token. `recipient`/`toAta` are the user's
 * Phantom wallet pubkey + its associated-token-account, derived off-chain by the
 * caller (standard getAssociatedTokenAddress(mint, recipient)) — avoids an
 * on-chain find_program_address dependency, matching FaucetEgress.
 *
 * One claim = one atomic Solana tx (1 ATA-create + 1 transfer_spl), well under
 * the 1.4M-CU per-tx cap; the UI loops claim() per faucet token.
 */
contract SelfServeFaucet {
    /// rome-evm HelperProgram precompile (0xff..09).
    address constant HELPER = 0xff00000000000000000000000000000000000009;

    /// Admin may set per-mint drop amounts. Set to the deployer at construction.
    address public admin;

    /// Per-mint drop size (raw SPL units, u64). 0 = mint not offered by the faucet.
    mapping(bytes32 => uint64) public dropAmount;

    /// One-time drip per (recipient Phantom wallet, mint).
    mapping(bytes32 => mapping(bytes32 => bool)) public claimed;

    event DropConfigured(bytes32 indexed mint, uint64 amount);
    event Dropped(bytes32 indexed recipient, bytes32 indexed mint, uint64 amount);
    event AdminTransferred(address indexed from, address indexed to);

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "SelfServeFaucet: not admin");
        _;
    }

    function transferAdmin(address to) external onlyAdmin {
        require(to != address(0), "SelfServeFaucet: admin zero");
        emit AdminTransferred(admin, to);
        admin = to;
    }

    /// Configure (or update) the per-mint drop size. Set 0 to retire a mint.
    function setDrop(bytes32 mint, uint64 amount) public onlyAdmin {
        dropAmount[mint] = amount;
        emit DropConfigured(mint, amount);
    }

    /// Batch variant of setDrop.
    function setDrops(bytes32[] calldata mints, uint64[] calldata amounts) external onlyAdmin {
        require(mints.length == amounts.length, "SelfServeFaucet: len mismatch");
        for (uint256 i = 0; i < mints.length; i++) {
            dropAmount[mints[i]] = amounts[i];
            emit DropConfigured(mints[i], amounts[i]);
        }
    }

    /// @notice Drip the configured amount of `mint` to the caller's own Phantom
    ///         wallet ATA. Reverts if already claimed for this (recipient, mint)
    ///         or if the mint isn't offered.
    /// @param recipient Phantom wallet pubkey (32 bytes) — the drop destination owner.
    /// @param toAta     recipient's associated-token-account for `mint`, derived
    ///                  off-chain (getAssociatedTokenAddress(mint, recipient)).
    /// @param mint      SPL mint pubkey (32 bytes).
    function claim(bytes32 recipient, bytes32 toAta, bytes32 mint) external {
        require(recipient != bytes32(0), "SelfServeFaucet: recipient zero");
        uint64 amount = dropAmount[mint];
        require(amount > 0, "SelfServeFaucet: mint not offered");
        require(!claimed[recipient][mint], "SelfServeFaucet: already claimed");
        claimed[recipient][mint] = true;

        // CPI 1 — idempotent create of the recipient's wallet ATA. No-op if it exists.
        (bool ataOk, bytes memory ataRes) = HELPER.call(
            abi.encodeWithSignature("create_ata_for_key(bytes32,bytes32)", recipient, mint)
        );
        require(ataOk, _revmsg(ataRes, "SelfServeFaucet: create_ata failed"));

        // CPI 2 — SPL transfer from external_auth(address(this))'s ATA -> toAta.
        // CALL (not delegatecall): the precompile's msg.sender is THIS contract,
        // so the source is the faucet's own reserve PDA, signed by the program.
        (bool xferOk, bytes memory xferRes) = HELPER.call(
            abi.encodeWithSignature("transfer_spl(bytes32,uint64,bytes32)", toAta, amount, mint)
        );
        require(xferOk, _revmsg(xferRes, "SelfServeFaucet: transfer failed"));

        emit Dropped(recipient, mint, amount);
    }

    /// Decode a bubbled Error(string) revert reason, else a fallback label.
    function _revmsg(bytes memory ret, string memory fallbackMsg) private pure returns (string memory) {
        if (ret.length < 68) return fallbackMsg;
        assembly {
            ret := add(ret, 0x04)
        }
        return abi.decode(ret, (string));
    }
}
