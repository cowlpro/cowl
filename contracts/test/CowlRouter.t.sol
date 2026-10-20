// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {CowlRouter} from "../src/CowlRouter.sol";

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// Tes di fork mainnet Robinhood Chain: Announcer asli + token saham NVDA asli.
contract CowlRouterForkTest is Test {
    address constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    bytes32 constant ANNOUNCEMENT_SIG =
        keccak256("Announcement(uint256,address,address,bytes,bytes)");

    CowlRouter router;
    address sender = makeAddr("sender");
    address stealth = makeAddr("stealth");
    bytes eph = hex"02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

    function setUp() public {
        vm.createSelectFork("robinhood");
        router = new CowlRouter();
        vm.deal(sender, 1 ether);
    }

    function test_sendEth_moves_funds_and_announces() public {
        vm.recordLogs();
        vm.prank(sender);
        router.sendEth{value: 0.01 ether}(stealth, eph, bytes1(0x7f));
        assertEq(stealth.balance, 0.01 ether);
        assertEq(address(router).balance, 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, ANNOUNCER);
        assertEq(logs[0].topics[0], ANNOUNCEMENT_SIG);
        assertEq(uint256(logs[0].topics[1]), 1);
        assertEq(address(uint160(uint256(logs[0].topics[2]))), stealth);
        assertEq(address(uint160(uint256(logs[0].topics[3]))), address(router));
        (bytes memory e, bytes memory meta) = abi.decode(logs[0].data, (bytes, bytes));
        assertEq(e, eph);
        assertEq(meta.length, 57);
        assertEq(uint8(meta[0]), 0x7f);
    }

    function test_sendToken_stock_with_gas_tip() public {
        deal(NVDA, sender, 5 ether);
        vm.startPrank(sender);
        IERC20(NVDA).approve(address(router), 2 ether);
        vm.recordLogs();
        router.sendToken{value: 0.0001 ether}(NVDA, 2 ether, stealth, eph, bytes1(0x01));
        vm.stopPrank();
        assertEq(IERC20(NVDA).balanceOf(stealth), 2 ether);
        assertEq(IERC20(NVDA).balanceOf(sender), 3 ether);
        assertEq(stealth.balance, 0.0001 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (, bytes memory meta) = abi.decode(logs[logs.length - 1].data, (bytes, bytes));
        assertEq(meta.length, 89);

        // penerima menarik dari alamat stealth: ukur gas transfer token saham dari EOA baru
        address dest = makeAddr("dest");
        vm.prank(stealth);
        uint256 g = gasleft();
        IERC20(NVDA).transfer(dest, 2 ether);
        emit log_named_uint("gas NVDA transfer dari stealth", g - gasleft());
        assertEq(IERC20(NVDA).balanceOf(dest), 2 ether);
    }

    function test_reverts() public {
        vm.startPrank(sender);
        vm.expectRevert(CowlRouter.ZeroAmount.selector);
        router.sendEth{value: 0}(stealth, eph, bytes1(0));
        vm.expectRevert(CowlRouter.ZeroStealthAddress.selector);
        router.sendEth{value: 1}(address(0), eph, bytes1(0));
        vm.expectRevert(CowlRouter.BadEphemeralKey.selector);
        router.sendEth{value: 1}(stealth, hex"04aa", bytes1(0));
        // tanpa approve
        deal(NVDA, sender, 1 ether);
        vm.expectRevert();
        router.sendToken(NVDA, 1 ether, stealth, eph, bytes1(0));
        // bukan kontrak
        vm.expectRevert(CowlRouter.TokenTransferFailed.selector);
        router.sendToken(makeAddr("eoa"), 1, stealth, eph, bytes1(0));
        vm.stopPrank();
    }
}
