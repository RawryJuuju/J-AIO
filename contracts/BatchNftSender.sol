// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title BatchNftSender
/// @notice Move many of the CALLER's NFTs to one destination in a single tx.
///         The caller must first approve this contract on each collection:
///             collection.setApprovalForAll(<this address>, true)
///         No admin, no storage, no ETH handling — this contract can only move
///         tokens owned by msg.sender (the wallet that calls it).
contract BatchNftSender {
    /// @notice Send `ids` of ERC721 `token` from msg.sender to `to`.
    ///         Uses transferFrom (works even if `to` is a contract without
    ///         an ERC721 receiver hook). Atomic: reverts if any id fails.
    function send721(address token, uint256[] calldata ids, address to) external {
        for (uint256 i = 0; i < ids.length; i++) {
            (bool ok, ) = token.call(
                abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, to, ids[i])
            );
            require(ok, "721: transfer failed");
        }
    }

    /// @notice Send ERC1155 `ids`/`amounts` of `token` from msg.sender to `to`.
    function send1155(address token, uint256[] calldata ids, uint256[] calldata amounts, address to) external {
        require(ids.length == amounts.length, "1155: length mismatch");
        (bool ok, ) = token.call(
            abi.encodeWithSignature(
                "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
                msg.sender, to, ids, amounts, ""
            )
        );
        require(ok, "1155: transfer failed");
    }
}
