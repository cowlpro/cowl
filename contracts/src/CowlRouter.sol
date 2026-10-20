// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Announcer resmi ERC-5564 (sudah terpasang di Robinhood Chain).
interface IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}

/// @title COWL Router
/// @notice Mengirim ETH atau ERC-20 ke alamat stealth lalu mencatat pengumumannya dalam SATU transaksi.
/// Kontrak ini tanpa owner, tanpa fee, tanpa fungsi admin, dan tidak pernah menyimpan dana.
contract CowlRouter {
    IERC5564Announcer public constant ANNOUNCER = IERC5564Announcer(0x55649E01B5Df198D18D95b5cc5051630cfD45564);
    /// @dev Skema 1 = secp256k1 dengan view tag.
    uint256 public constant SCHEME_ID = 1;
    /// @dev Penanda ETH sesuai ERC-5564.
    bytes4 private constant ETH_MARKER = 0xeeeeeeee;
    address private constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    /// @dev Selector transfer(address,uint256), dipakai metadata ERC-20 sesuai ERC-5564.
    bytes4 private constant TRANSFER_SELECTOR = 0xa9059cbb;

    error ZeroStealthAddress();
    error ZeroAmount();
    error BadEphemeralKey();
    error EthTransferFailed();
    error TokenTransferFailed();

    /// @notice Kirim ETH ke alamat stealth.
    function sendEth(address stealth, bytes calldata ephemeralPubKey, bytes1 viewTag) external payable {
        _check(stealth, msg.value, ephemeralPubKey);
        _sendEth(stealth, msg.value);
        ANNOUNCER.announce(
            SCHEME_ID, stealth, ephemeralPubKey, abi.encodePacked(viewTag, ETH_MARKER, ETH_TOKEN, msg.value)
        );
    }

    /// @notice Kirim ERC-20 ke alamat stealth. ETH yang ikut (msg.value) diteruskan sebagai ongkos tarik.
    /// @dev Pengirim wajib approve Router sebesar `amount` dulu.
    function sendToken(
        address token,
        uint256 amount,
        address stealth,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag
    ) external payable {
        _check(stealth, amount, ephemeralPubKey);
        _safeTransferFrom(token, msg.sender, stealth, amount);
        if (msg.value > 0) _sendEth(stealth, msg.value);
        // metadata: view tag | selector | token | jumlah | ongkos tarik yang ikut
        ANNOUNCER.announce(
            SCHEME_ID,
            stealth,
            ephemeralPubKey,
            abi.encodePacked(viewTag, TRANSFER_SELECTOR, token, amount, msg.value)
        );
    }

    function _check(address stealth, uint256 amount, bytes calldata ephemeralPubKey) private pure {
        if (stealth == address(0)) revert ZeroStealthAddress();
        if (amount == 0) revert ZeroAmount();
        // kunci publik terkompresi secp256k1: 33 byte, awalan 0x02/0x03
        if (ephemeralPubKey.length != 33 || (ephemeralPubKey[0] != 0x02 && ephemeralPubKey[0] != 0x03)) {
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
