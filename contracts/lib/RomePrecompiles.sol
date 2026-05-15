// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.15;

/// @title RomePrecompiles
/// @notice Self-contained Rome-EVM precompile bindings, copied from
/// rome-solidity (canonical source) so this build does not require the
/// rome-solidity package as a dependency.
///
/// Mirror: contracts/interface.sol in rome-solidity. Re-verify if rome-evm-
/// private rotates precompile addresses (it hasn't since the Mollusk refactor).
///
/// Precompile addresses:
///   SystemProgram — 0xFF...07  (PDA derivation, base58, mint id)
///   CpiProgram    — 0xFF...08  (account info read, signed/unsigned CPI)

interface ISystemProgram {
    struct Seed {
        bytes item;
    }
    function program_id() external view returns (bytes32);
    function rome_evm_program_id() external view returns (bytes32);
    function find_program_address(bytes32 program, Seed[] memory seeds)
        external pure returns (bytes32, uint8);
    function bytes32_to_base58(bytes32) external view returns (bytes memory);
    function base58_to_bytes32(bytes memory) external view returns (bytes32);
    function operator() external view returns (bytes32);
    function mint_id() external view returns (bytes32);
}

interface ICrossProgramInvocation {
    struct AccountMeta {
        bytes32 pubkey;
        bool is_signer;
        bool is_writable;
    }
    /// Canonical result element for `pdas_batch_derive` (selector 0x944336f8).
    /// Mirrors the upstream Solidity ABI defined in
    /// `rome-solidity/contracts/interface.sol` (struct + function signature
    /// verified 2026-05-15). Earlier compound-on-rome-comet revisions
    /// declared the return as two parallel arrays `(bytes32[], uint8[])` —
    /// that was wrong: the precompile returns an array-of-struct, and the
    /// wrong ABI would mis-decode on-chain results.
    struct PdaWithBump {
        bytes32 pda;
        uint8 bump;
    }
    function invoke(bytes32 program_id, AccountMeta[] memory accounts, bytes memory data)
        external;
    function invoke_signed(
        bytes32 program_id,
        AccountMeta[] memory accounts,
        bytes memory data,
        bytes32[] memory seeds
    ) external;
    function account_info(bytes32 pubkey)
        external view
        returns (uint64, bytes32, bool, bool, bool, bytes memory);

    // ────────────────────────────────────────────────────────────────────
    // CPI precompile shortcuts (rome-evm-private PR #318 + #319):
    //   - read-side: account_data_at, account_u64_at, account_lamports —
    //     skip the 6-tuple ABI encoding overhead of `account_info` for
    //     callers that only need a slice / typed value / lamports.
    //   - write-side: spl_transfer_checked_v1 — builds the AccountMeta[4]
    //     and 10-byte ix data in Rust, signing as caller's external_auth
    //     PDA. Saves ~500k CU per call vs Solidity-side AccountMeta
    //     marshaling through invoke_signed.
    //   - derivation helpers: derive_user_ata (Rome user → ATA in one
    //     syscall), pdas_batch_derive (N PDAs in one call).
    // Mirror: rome-evm-private/program/src/non_evm/cpi.rs selector consts.
    // ────────────────────────────────────────────────────────────────────

    /// Read `length` bytes of account `pubkey`'s data starting at `offset`.
    /// Reverts if (offset + length) > data.len() OR the account is missing
    /// in the program-side context (emulator returns empty data, which
    /// also reverts on any non-zero length).
    function account_data_at(bytes32 pubkey, uint16 offset, uint16 length)
        external view returns (bytes memory);

    /// SPL Token Classic transfer_checked. `salts.length == 0` → signs as
    /// caller's external_auth PDA; non-empty → first salt-derived PDA is
    /// the signer.
    function spl_transfer_checked_v1(
        bytes32 src_ata,
        bytes32 mint,
        bytes32 dst_ata,
        uint64 amount,
        uint8 decimals,
        bytes32[] memory salts
    ) external returns (bool);

    /// Read u64 LE at `offset` of account data. Sugar over
    /// `account_data_at(pubkey, offset, 8)` with native u64 decode.
    /// Reverts on missing account (use account_lamports first as a
    /// cheap existence probe).
    function account_u64_at(bytes32 pubkey, uint16 offset)
        external view returns (uint64);

    /// Lamports-only read. Returns 0 for missing accounts in emulator
    /// context; reverts in program context for accounts not in the
    /// instruction's account list.
    function account_lamports(bytes32 pubkey)
        external view returns (uint64);

    /// Rome user PDA → ATA derivation in one syscall. Equivalent to
    /// `find_program_address([EXTERNAL_AUTHORITY, evm_user], rome_evm)`
    /// then `find_program_address([owner_pda, SPL_TOKEN, mint], ata_program)`,
    /// but skips the EVM-side double-derivation.
    function derive_user_ata(address evm_user, bytes32 mint)
        external view returns (bytes32);

    /// Batched PDA derivation (selector 0x944336f8). Each `seed_groups[i]`
    /// is a list of seed segments; returns one `PdaWithBump` per input
    /// group, in order. Limits enforced by the precompile: N ≤ 16 seed
    /// groups, M ≤ 8 inner seeds per group, 32 bytes per seed.
    ///
    /// Canonical Solidity wrapper for this selector lives in rome-solidity
    /// `contracts/cpi/PdasBatch.sol` (`PdasBatch.derive` + `.pair` /
    /// `.triplet` / `.quad`). Adapters in this repo can stay self-contained
    /// against the interface declared here; semantics match upstream.
    function pdas_batch_derive(bytes[][] memory seed_groups, bytes32 program_id)
        external view returns (PdaWithBump[] memory);
}

address constant SYSTEM_PROGRAM_ADDRESS = address(0xfF00000000000000000000000000000000000007);
address constant CPI_PROGRAM_ADDRESS = address(0xFF00000000000000000000000000000000000008);

/// Solana program / sysvar pubkeys (bytes32 LE-encoded).
library SolanaConstants {
    /// All-zero — System Program (11111111111111111111111111111111).
    bytes32 internal constant SYSTEM_PROGRAM = bytes32(0);

    /// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA — classic SPL Token.
    bytes32 internal constant SPL_TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;

    /// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL — Associated Token.
    bytes32 internal constant ASSOCIATED_TOKEN_PROGRAM =
        0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859;
}

// Bound singletons callers reach via `SystemProgram.x()` / `CpiProgram.y()`.
ISystemProgram constant SystemProgram = ISystemProgram(SYSTEM_PROGRAM_ADDRESS);
ICrossProgramInvocation constant CpiProgram = ICrossProgramInvocation(CPI_PROGRAM_ADDRESS);
