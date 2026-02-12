// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";

interface IRouter {
    function createProgram(bytes32 codeId, bytes32 salt, address overrideInitializer) external returns (address);
    function createProgramWithAbiInterface(
        bytes32 codeId,
        bytes32 salt,
        address overrideInitializer,
        address abiInterface
    ) external returns (address);
    function wrappedVara() external view returns (address);
    event ProgramCreated(address actorId, bytes32 indexed codeId);
}

interface IMirror {
    function sendMessage(bytes calldata payload, bool callReply) external payable returns (bytes32);
    function executableBalanceTopUp(uint128 value) external;
    event StateChanged(bytes32 stateHash);
}

interface IWrappedVara {
    function approve(address spender, uint256 value) external returns (bool);
}

contract CreateMirrorProgram is Script {
    uint256 constant WVARA_DECIMALS = 12;
    uint128 constant TOP_UP_AMOUNT = 100 * uint128(10 ** WVARA_DECIMALS);

    function waitForStateChanged(address programAddress, uint256 fromBlock, uint256 maxAttempts)
        internal
        returns (bytes32)
    {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = keccak256("StateChanged(bytes32)");

        for (uint256 attempts = 0; attempts < maxAttempts; attempts++) {
            vm.sleep(1000);

            Vm.EthGetLogs[] memory ethLogs = vm.eth_getLogs(fromBlock, block.number, programAddress, topics);
            if (ethLogs.length > 0) {
                return ethLogs[0].topics[1];
            }

            console.log("Attempt", attempts + 1, "/", maxAttempts);
        }

        revert("StateChanged event not detected within timeout");
    }

    function run() external {
        bytes32 pkBytes = vm.envBytes32("PRIVATE_KEY");

        address routerAddress = vm.envAddress("ROUTER_ADDRESS");
        bytes32 codeId = vm.envBytes32("CODE_ID");
        address abiInterface = vm.envOr("ABI_INTERFACE", address(0));

        bytes memory initPayload = vm.envBytes("INIT_PAYLOAD");
        uint256 maxWaitAttempts = vm.envOr("MAX_WAIT_ATTEMPTS", uint256(10));

        uint256 deployerPrivateKey = uint256(pkBytes);

        console.log("Router Address:", routerAddress);
        console.log("Code ID:", vm.toString(codeId));
        console.log("ABI Interface:", abiInterface);
        console.log("Init Payload:", vm.toString(initPayload));

        IRouter router = IRouter(routerAddress);

        // Step 1: createProgram — ProgramCreated is emitted in the same tx
        console.log("\n--- Step 1: Creating program ---");
        vm.recordLogs();
        vm.startBroadcast(deployerPrivateKey);

        bytes32 salt = bytes32(vm.randomBytes(32));
        address programAddress;

        if (abiInterface != address(0)) {
            programAddress = router.createProgramWithAbiInterface(codeId, salt, address(0), abiInterface);
        } else {
            programAddress = router.createProgram(codeId, salt, address(0));
        }
        console.log("block", block.number);

        vm.stopBroadcast();

        // Verify ProgramCreated was emitted in the tx
        bytes32 programCreatedSig = keccak256("ProgramCreated(address,bytes32)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == routerAddress && logs[i].topics[0] == programCreatedSig) {
                found = true;
                break;
            }
        }
        require(found, "ProgramCreated event not found in tx");
        console.log("Program created:", programAddress);

        // Step 2: Approve WVara
        console.log("\n--- Step 2: Approving WVara ---");
        address wvaraAddress = router.wrappedVara();
        console.log("WVara address:", wvaraAddress);

        vm.startBroadcast(deployerPrivateKey);
        IWrappedVara(wvaraAddress).approve(programAddress, TOP_UP_AMOUNT);
        vm.stopBroadcast();

        console.log("Approved", TOP_UP_AMOUNT, "WVara.");

        // Step 3: executableBalanceTopUp and wait for StateChanged
        console.log("\n--- Step 3: Topping up executable balance ---");
        vm.startBroadcast(deployerPrivateKey);
        IMirror(programAddress).executableBalanceTopUp(TOP_UP_AMOUNT);
        // uint256 afterTopUpBlock = block.number;
        vm.stopBroadcast();

        console.log("Waiting for StateChanged after top-up...");
        // bytes32 stateHash = waitForStateChanged(programAddress, afterTopUpBlock, maxWaitAttempts);
        // console.log("StateChanged:", vm.toString(stateHash));

        // Step 4: Send init message and wait for StateChanged
        console.log("\n--- Step 4: Sending init message ---");
        vm.startBroadcast(deployerPrivateKey);
        bytes32 messageId = IMirror(programAddress).sendMessage(initPayload, false);
        // uint256 afterSendBlock = block.number;
        vm.stopBroadcast();

        console.log("Init message sent. ID:", vm.toString(messageId));
        // console.log("Waiting for StateChanged after init...");
        // stateHash = waitForStateChanged(programAddress, afterSendBlock, maxWaitAttempts);
        // console.log("StateChanged:", vm.toString(stateHash));

        console.log("\nDone. Program address:", programAddress);
    }
}
