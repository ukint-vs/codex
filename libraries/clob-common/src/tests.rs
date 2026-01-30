#[cfg(test)]
mod tests {
    use crate::{actor_to_eth, eth_to_actor, EthAddress};

    #[test]
    fn test_eth_actor_conversion() {
        let addr: EthAddress = [0x12; 20];
        let actor = eth_to_actor(addr);
        let recovered = actor_to_eth(actor);
        assert_eq!(addr, recovered, "Recovered address should match original");
    }

    #[test]
    fn test_actor_is_right_aligned() {
        let addr: EthAddress = [0x12; 20];
        let actor = eth_to_actor(addr);
        let bytes: [u8; 32] = actor.into();
        
        let mut expected_right = [0u8; 32];
        expected_right[12..].copy_from_slice(&addr);
        
        assert_eq!(bytes, expected_right, "ActorId should be RIGHT-aligned for Ethereum compatibility");
    }
}
