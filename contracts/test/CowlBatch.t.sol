// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {CowlBatch} from "../src/CowlBatch.sol";

interface IERC20b {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// Tes di fork mainnet Robinhood Chain: Announcer asli + token saham NVDA asli.
contract CowlBatchForkTest is Test {
    address constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    bytes32 constant ANNOUNCEMENT_SIG = keccak256("Announcement(uint256,address,address,bytes,bytes)");

    CowlBatch batch;
    address sender = makeAddr("sender");
    bytes eph = hex"02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

    function setUp() public {
        vm.createSelectFork("robinhood");
        batch = new CowlBatch();
        vm.deal(sender, 10 ether);
    }

    function _payments(uint256 n, uint256 each) internal returns (CowlBatch.Payment[] memory ps) {
        ps = new CowlBatch.Payment[](n);
        for (uint256 i; i < n; ++i) {
            ps[i] = CowlBatch.Payment(makeAddr(string(abi.encodePacked("stealth", vm.toString(i)))), eph, bytes1(uint8(i)), each * (i + 1));
        }
    }

    function test_ethBatch_pays_everyone_and_announces_each() public {
        CowlBatch.Payment[] memory ps = _payments(3, 0.01 ether); // 0.01 + 0.02 + 0.03
        vm.recordLogs();
        vm.prank(sender);
        batch.sendEthBatch{value: 0.06 ether}(ps);
        for (uint256 i; i < 3; ++i) assertEq(ps[i].stealth.balance, 0.01 ether * (i + 1));
        assertEq(address(batch).balance, 0, "batch tidak boleh menyimpan ETH");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(logs[i].emitter, ANNOUNCER);
            assertEq(logs[i].topics[0], ANNOUNCEMENT_SIG);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), ps[i].stealth);
            assertEq(address(uint160(uint256(logs[i].topics[3]))), address(batch));
        }
    }

    function test_tokenBatch_with_tip() public {
        CowlBatch.Payment[] memory ps = _payments(4, 1e18); // 1+2+3+4 = 10 NVDA
        deal(NVDA, sender, 10e18);
        uint256 tip = 0.00002 ether;
        vm.startPrank(sender);
        IERC20b(NVDA).approve(address(batch), 10e18);
        uint256 g = gasleft();
        batch.sendTokenBatch{value: tip * 4}(NVDA, ps, tip);
        emit log_named_uint("gas 4 pembayaran NVDA", g - gasleft());
        vm.stopPrank();
        for (uint256 i; i < 4; ++i) {
            assertEq(IERC20b(NVDA).balanceOf(ps[i].stealth), 1e18 * (i + 1));
            assertEq(ps[i].stealth.balance, tip);
        }
        assertEq(IERC20b(NVDA).balanceOf(address(batch)), 0);
        assertEq(address(batch).balance, 0);
    }

    function test_reverts() public {
        CowlBatch.Payment[] memory ps = _payments(2, 0.01 ether);
        vm.startPrank(sender);
        vm.expectRevert(CowlBatch.ValueMismatch.selector);
        batch.sendEthBatch{value: 0.02 ether}(ps); // seharusnya 0.03
        vm.expectRevert(CowlBatch.EmptyBatch.selector);
        batch.sendEthBatch{value: 0}(new CowlBatch.Payment[](0));
        vm.expectRevert(CowlBatch.TooManyPayments.selector);
        batch.sendEthBatch{value: 0}(new CowlBatch.Payment[](101));
        vm.expectRevert(CowlBatch.ValueMismatch.selector);
        batch.sendTokenBatch{value: 1}(NVDA, ps, 0); // tip tidak cocok
        ps[1].ephemeralPubKey = hex"04";
        vm.expectRevert(CowlBatch.BadEphemeralKey.selector);
        batch.sendEthBatch{value: 0.03 ether}(ps);
        vm.stopPrank();
    }
}
