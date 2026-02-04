use clob_common::{actor_to_eth, eth_to_actor};
use sails_rs::prelude::*;
use vault_app::encode_release_funds;

#[test]
fn test_encode_release_funds() {
    let user_eth = [1u8; 20];
    let user = eth_to_actor(user_eth);
    let token = [2u8; 20];
    let amount = 0x123456789abcdef0123456789abcdef0u128;

    let payload = encode_release_funds(user, token, amount);

    // Selector: 8bbdf2af
    assert_eq!(&payload[0..4], &[0x8b, 0xbd, 0xf2, 0xaf]);

    // User: 32 bytes, left-padded
    assert_eq!(&payload[4..16], &[0u8; 12]);
    assert_eq!(&payload[16..36], &actor_to_eth(user));

    // Token: 32 bytes, left-padded
    assert_eq!(&payload[36..48], &[0u8; 12]);
    assert_eq!(&payload[48..68], &token);

    // Amount: 32 bytes, big-endian u256
    // u128 is 16 bytes.
    assert_eq!(&payload[68..84], &[0u8; 16]);
    assert_eq!(&payload[84..100], &amount.to_be_bytes());
}

#[test]
fn test_encode_release_funds_small_amount() {
    let user_eth = [0xAAu8; 20];
    let user = eth_to_actor(user_eth);
    let token = [0xBBu8; 20];
    let amount = 100u128;

    let payload = encode_release_funds(user, token, amount);

    assert_eq!(&payload[0..4], &[0x8b, 0xbd, 0xf2, 0xaf]);

    // Amount: 100 in big-endian u256
    let mut expected_amount = [0u8; 32];
    expected_amount[31] = 100;
    assert_eq!(&payload[68..100], &expected_amount);
}
