// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Announcer resmi ERC-5564 (sudah terpasang di Robinhood Chain).
interface IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}

/// @title COWL Batch (private payroll)
/// @notice Membayar banyak link COWL dalam SATU transaksi: tiap penerima mendapat alamat stealth sendiri
/// dan satu pengumuman ERC-5564, persis seperti CowlRouter tetapi berulang.
/// Kontrak ini tanpa owner, tanpa fee, tanpa fungsi admin, dan tidak pernah menyimpan dana.
contract CowlBatch {
    IERC5564Announcer public constant ANNOUNCER = IERC5564Announcer(0x55649E01B5Df198D18D95b5cc5051630cfD45564);
    uint256 public constant SCHEME_ID = 1;
    /// @dev Batas penerima per transaksi supaya tetap jauh di bawah batas gas blok.
    uint256 public constant MAX_PAYMENTS = 100;
    bytes4 private constant ETH_MARKER = 0xeeeeeeee;
    address private constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    bytes4 private constant TRANSFER_SELECTOR = 0xa9059cbb;

    struct Payment {
        address stealth;
        bytes ephemeralPubKey;
        bytes1 viewTag;
        uint256 amount;
    }

    error EmptyBatch();
    error TooManyPayments();
    error ValueMismatch();
    error ZeroStealthAddress();
    error ZeroAmount();
    error BadEphemeralKey();
    error EthTransferFailed();
    error TokenTransferFailed();

    /// @notice Kirim ETH ke banyak alamat stealth. msg.value wajib sama dengan total semua jumlah.
    function sendEthBatch(Payment[] calldata payments) external payable {
        uint256 n = _count(payments);
        uint256 total;
        for (uint256 i; i < n; ++i) total += payments[i].amount;
        if (total != msg.value) revert ValueMismatch();
        for (uint256 i; i < n; ++i) {
            Payment calldata p = payments[i];
            _check(p);
            _sendEth(p.stealth, p.amount);
            ANNOUNCER.announce(
                SCHEME_ID, p.stealth, p.ephemeralPubKey, abi.encodePacked(p.viewTag, ETH_MARKER, ETH_TOKEN, p.amount)
            );
        }
    }

    /// @notice Kirim satu ERC-20 ke banyak alamat stealth. Tiap penerima juga mendapat `tipEach` ETH
    /// sebagai ongkos tarik; msg.value wajib = tipEach × jumlah penerima.
    /// @dev Pengirim wajib approve kontrak ini sebesar total token dulu.
    function sendTokenBatch(address token, Payment[] calldata payments, uint256 tipEach) external payable {
        uint256 n = _count(payments);
        if (msg.value != tipEach * n) revert ValueMismatch();
        for (uint256 i; i < n; ++i) {
            Payment calldata p = payments[i];
            _check(p);
            _safeTransferFrom(token, msg.sender, p.stealth, p.amount);
            if (tipEach > 0) _sendEth(p.stealth, tipEach);
            // metadata sama dengan CowlRouter: view tag | selector | token | jumlah | ongkos tarik
            ANNOUNCER.announce(
                SCHEME_ID,
                p.stealth,
                p.ephemeralPubKey,
                abi.encodePacked(p.viewTag, TRANSFER_SELECTOR, token, p.amount, tipEach)
            );
        }
    }

    function _count(Payment[] calldata payments) private pure returns (uint256 n) {
        n = payments.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_PAYMENTS) revert TooManyPayments();
    }

    function _check(Payment calldata p) private pure {
        if (p.stealth == address(0)) revert ZeroStealthAddress();
        if (p.amount == 0) revert ZeroAmount();
        if (p.ephemeralPubKey.length != 33 || (p.ephemeralPubKey[0] != 0x02 && p.ephemeralPubKey[0] != 0x03)) {
            revert BadEphemeralKey();
        }
    }

    function _sendEth(address to, uint256 value) private {
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @dev Mendukung token yang tidak mengembalikan bool.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        if (token.code.length == 0) revert TokenTransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }
}
