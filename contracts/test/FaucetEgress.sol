// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

/**
 * Operator-driven SPL drop to a raw Solana wallet, parameterized by mint.
 *
 * `drop` transfers `amount` of `mint` from the CALLER's unified-user-PDA ATA
 * (external_auth(msg.sender)) to `recipient`'s associated-token-account, which
 * it creates idempotently first. So test funds land in the user's OWN Phantom
 * wallet — the origin the Solana-native lane's supply flow pulls from (supply =
 * wallet ATA -> synthetic ATA -> Comet; the synthetic is a pass-through).
 *
 * Why a standalone contract: SPL_ERC20.bridgeOutToSolana exists only on the
 * non-cached wrapper and is hard-bound to that wrapper's single mint; the
 * cached collateral wrappers expose no bridge-out at all. This generalizes the
 * same two-CPI body (create_ata_for_key + raw-ATA transfer_spl) over an
 * arbitrary mint so ONE deployed contract serves every faucet token.
 *
 * Mechanics:
 *   - The faucet operator (the deployer, which already holds the full mint
 *     supply EVM-side in its external_auth PDA ATA) signs the EVM tx. Rome's
 *     HelperProgram precompile derives the SOURCE ATA from external_auth(
 *     msg.sender) and signs the SPL transfer as that PDA.
 *   - `toAta` is the recipient's associated-token-account, derived off-chain by
 *     the caller (standard getAssociatedTokenAddress(mint, recipient)) and
 *     passed in — avoids an on-chain find_program_address dependency.
 *   - create_ata_for_key is legacy-track (CPI-only); one `drop` = one atomic
 *     Solana tx (1 ATA-create + 1 transfer), well under the 1.4M-CU cap. The
 *     backend loops `drop` per mint (each its own tx) so the user just clicks
 *     once and signs nothing.
 */
contract FaucetEgress {
    /// rome-evm HelperProgram precompile (0xff..09).
    address constant HELPER = 0xff00000000000000000000000000000000000009;

    event Dropped(
        address indexed operator,
        bytes32 indexed recipient,
        bytes32 indexed mint,
        uint64 amount
    );

    /// @notice Drop `amount` of `mint` to `recipient`'s ATA (created if absent).
    /// @param recipient Solana wallet pubkey (32 bytes) that receives the tokens.
    /// @param toAta     recipient's associated-token-account for `mint`, derived
    ///                  off-chain (getAssociatedTokenAddress(mint, recipient)).
    /// @param mint      SPL mint pubkey (32 bytes).
    /// @param amount    raw token units (u64).
    function drop(bytes32 recipient, bytes32 toAta, bytes32 mint, uint64 amount) public {
        require(recipient != bytes32(0), "FaucetEgress: recipient zero");
        require(amount > 0, "FaucetEgress: amount zero");

        // CPI 1 — idempotent create of the recipient's raw-pubkey ATA. Operator
        // pays rent (reimbursed via Rome gas accounting). No-op if it exists.
        (bool ataOk, bytes memory ataRes) = HELPER.delegatecall(
            abi.encodeWithSignature("create_ata_for_key(bytes32,bytes32)", recipient, mint)
        );
        require(ataOk, _revmsg(ataRes, "FaucetEgress: create_ata failed"));

        // CPI 2 — SPL transfer from external_auth(msg.sender)'s ATA -> toAta.
        // Signs as the caller's PDA (the operator that holds the supply).
        (bool xferOk, bytes memory xferRes) = HELPER.delegatecall(
            abi.encodeWithSignature("transfer_spl(bytes32,uint64,bytes32)", toAta, amount, mint)
        );
        require(xferOk, _revmsg(xferRes, "FaucetEgress: transfer failed"));

        emit Dropped(msg.sender, recipient, mint, amount);
    }

    /// Decode a bubbled Error(string) revert reason, else a fallback label.
    function _revmsg(bytes memory ret, string memory fallbackMsg) private pure returns (string memory) {
        if (ret.length < 68) return fallbackMsg;
        assembly { ret := add(ret, 0x04) }
        return abi.decode(ret, (string));
    }
}
