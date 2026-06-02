// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

/**
 * Test-fund faucet for the compound-on-rome-demo /faucet page.
 *
 * Drops, per wallet, AT MOST ONCE PER TOKEN:
 *   1. `gasDrop` native gas (the first claim only)
 *   2. `tokenDrop[token]` of each registered ERC20
 *
 * Two entry points:
 *   - `claim()`            — claim everything (gas + all tokens). The EVM lane
 *                            uses this; Rome's iterative VM spreads it across
 *                            multiple Solana txs, so the per-tx CU cap is moot.
 *   - `claimTokens(s,c)`   — claim the `[s, s+c)` window of the token list. The
 *                            Solana-native lane submits each action as ONE
 *                            atomic Solana tx capped at 1.4M CU; six cached-
 *                            wrapper transfers over-run it, so the lane claims
 *                            in two sequential windows that each fit. Idempotent
 *                            and resumable — already-claimed tokens are skipped,
 *                            so windows may overlap and a repeat is a no-op.
 *
 * Pre-funding is the operator's job — unlike Aave's Faucet which mints from
 * `MockToken`s with public mint, Compound's `SPL_ERC20_cached` wrappers have no
 * public mint. Deployer transfers an inventory of each wrapper to this contract
 * before claims open and tops it up periodically.
 *
 * Deployer is the owner. Pre-funds native gas via the constructor's payable +
 * `receive()`. Pre-funds tokens via direct ERC20 transfer to `address(this)` —
 * anyone can top up.
 */
interface IERC20Min {
  function transfer(address to, uint256 amount) external returns (bool);
  function balanceOf(address account) external view returns (uint256);
}

contract CompoundFaucet {
  address public immutable owner;
  uint256 public immutable gasDrop;
  address[] public tokens;
  mapping(address => uint256) public tokenDrop;
  // Per-token idempotency: a wallet may claim each token at most once, but
  // across separate txs (so a windowed claim can finish in a later tx). Native
  // gas is gated separately so it's sent exactly once regardless of windowing.
  mapping(address => mapping(address => bool)) public tokenClaimed;
  mapping(address => bool) public gasClaimed;

  event Claimed(address indexed user, uint256 gasAmount, uint256 tokenCount);
  event TokenAdded(address indexed token, uint256 amount);

  modifier onlyOwner() {
    require(msg.sender == owner, "CompoundFaucet: not owner");
    _;
  }

  constructor(uint256 _gasDrop) payable {
    owner = msg.sender;
    gasDrop = _gasDrop;
  }

  /// @notice Accept native gas top-ups any time.
  receive() external payable {}

  /// @notice Register an ERC20 with this faucet. `amount` is the per-claim
  /// drop in raw token units (caller pre-multiplies by 10**decimals).
  function addToken(address token, uint256 amount) external onlyOwner {
    tokens.push(token);
    tokenDrop[token] = amount;
    emit TokenAdded(token, amount);
  }

  /// @notice Claim everything in one tx: gas (if not yet claimed) + every token
  /// not yet claimed. The EVM lane uses this; on the Solana-native lane it would
  /// over-run the 1.4M-CU per-tx cap with 6 cached-wrapper transfers — that lane
  /// uses `claimTokens` windows instead.
  function claim() external {
    claimTokens(0, tokens.length);
  }

  /// @notice Claim the `[start, start + count)` window of the token list, plus
  /// the one-time gas drop on the caller's first claim. Already-claimed tokens
  /// in the window are skipped (idempotent), so two sequential windows finish a
  /// full claim and overlapping/repeat windows never double-drip. `count` past
  /// the end is clamped. Emits the gas + token amounts actually paid THIS call.
  function claimTokens(uint256 start, uint256 count) public {
    uint256 gasSent = 0;
    if (!gasClaimed[msg.sender]) {
      gasClaimed[msg.sender] = true;
      if (gasDrop > 0) {
        require(address(this).balance >= gasDrop, "CompoundFaucet: out of gas reserve");
        (bool ok, ) = msg.sender.call{value: gasDrop}("");
        require(ok, "CompoundFaucet: gas send failed");
        gasSent = gasDrop;
      }
    }

    uint256 n = tokens.length;
    uint256 end = start + count;
    if (end > n) end = n;

    uint256 dripped = 0;
    for (uint256 i = start; i < end; i++) {
      address t = tokens[i];
      if (tokenClaimed[msg.sender][t]) continue; // per-token at-most-once
      tokenClaimed[msg.sender][t] = true;
      uint256 amount = tokenDrop[t];
      if (amount > 0) {
        require(
          IERC20Min(t).balanceOf(address(this)) >= amount,
          "CompoundFaucet: out of token reserve"
        );
        require(IERC20Min(t).transfer(msg.sender, amount), "CompoundFaucet: token transfer failed");
        dripped++;
      }
    }

    emit Claimed(msg.sender, gasSent, dripped);
  }

  /// @notice Backward-compatible "fully claimed" view (same selector as the old
  /// `claimed` public mapping): true once gas + every registered token is claimed.
  /// The demo's /faucet button gates on this.
  function claimed(address user) external view returns (bool) {
    if (!gasClaimed[user]) return false;
    uint256 n = tokens.length;
    for (uint256 i = 0; i < n; i++) {
      if (!tokenClaimed[user][tokens[i]]) return false;
    }
    return true;
  }

  function tokenList() external view returns (address[] memory) {
    return tokens;
  }
}
