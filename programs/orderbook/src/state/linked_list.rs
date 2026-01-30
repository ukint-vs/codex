use super::arena::{Arena, Index};
use clob_common::Order; // Assuming this is available

#[derive(Debug, Clone)]
pub struct OrderNode {
    pub order: Order,
    pub prev: Option<Index>,
    pub next: Option<Index>,
}

impl OrderNode {
    pub fn new(order: Order) -> Self {
        Self {
            order,
            prev: None,
            next: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct OrderQueue {
    pub head: Option<Index>,
    pub tail: Option<Index>,
}

impl OrderQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_back(&mut self, arena: &mut Arena<OrderNode>, order: Order) -> Index {
        let mut node = OrderNode::new(order);

        if let Some(tail_idx) = self.tail {
            node.prev = Some(tail_idx);
            let new_idx = arena.alloc(node);

            // Link old tail to new node
            if let Some(tail_node) = arena.get_mut(tail_idx) {
                tail_node.next = Some(new_idx);
            }
            self.tail = Some(new_idx);
            new_idx
        } else {
            let new_idx = arena.alloc(node);
            self.head = Some(new_idx);
            self.tail = Some(new_idx);
            new_idx
        }
    }

    pub fn pop_front(&mut self, arena: &mut Arena<OrderNode>) -> Option<Order> {
        let head_idx = self.head?;

        // Remove node from arena (this retrieves value and frees slot)
        let node = arena.remove(head_idx)?;
        let next_idx = node.next;

        // Update Head
        self.head = next_idx;

        if let Some(new_head) = next_idx {
            if let Some(node) = arena.get_mut(new_head) {
                node.prev = None;
            }
        } else {
            self.tail = None;
        }

        Some(node.order)
    }

    pub fn remove(&mut self, arena: &mut Arena<OrderNode>, index: Index) -> Option<Order> {
        // We remove it from arena first to get the links.
        // Note: If we fail to remove (invalid index), we return None.
        let node = arena.remove(index)?;
        let prev = node.prev;
        let next = node.next;

        // Fix prev
        if let Some(prev_idx) = prev {
            if let Some(node) = arena.get_mut(prev_idx) {
                node.next = next;
            }
        } else {
            // Was head
            self.head = next;
        }

        // Fix next
        if let Some(next_idx) = next {
            if let Some(node) = arena.get_mut(next_idx) {
                node.prev = prev;
            }
        } else {
            // Was tail
            self.tail = prev;
        }

        Some(node.order)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clob_common::{OrderId, Price, Quantity, Side, TraderId};

    fn mock_order(id: OrderId, price: Price) -> Order {
        Order {
            id,
            trader: TraderId::from([0u8; 32]), // Dummy
            side: Side::Buy,
            price,
            quantity: 100,
            created_at: 0,
        }
    }

    #[test]
    fn test_push_pop() {
        let mut arena = Arena::new();
        let mut queue = OrderQueue::new();

        let o1 = mock_order(1, 100);
        let o2 = mock_order(2, 100);

        let idx1 = queue.push_back(&mut arena, o1.clone());
        let idx2 = queue.push_back(&mut arena, o2.clone());

        assert_eq!(queue.head, Some(idx1));
        assert_eq!(queue.tail, Some(idx2));

        let popped1 = queue.pop_front(&mut arena).unwrap();
        assert_eq!(popped1.id, 1);
        assert_eq!(queue.head, Some(idx2));

        let popped2 = queue.pop_front(&mut arena).unwrap();
        assert_eq!(popped2.id, 2);
        assert!(queue.head.is_none());
        assert!(queue.tail.is_none());
    }

    #[test]
    fn test_remove_middle() {
        let mut arena = Arena::new();
        let mut queue = OrderQueue::new();

        let idx1 = queue.push_back(&mut arena, mock_order(1, 100));
        let idx2 = queue.push_back(&mut arena, mock_order(2, 100));
        let idx3 = queue.push_back(&mut arena, mock_order(3, 100));

        // Remove middle
        let removed = queue.remove(&mut arena, idx2).unwrap();
        assert_eq!(removed.id, 2);

        // Check links
        let node1 = arena.get(idx1).unwrap();
        let node3 = arena.get(idx3).unwrap();

        assert_eq!(node1.next, Some(idx3));
        assert_eq!(node3.prev, Some(idx1));

        // Head/Tail unchanged
        assert_eq!(queue.head, Some(idx1));
        assert_eq!(queue.tail, Some(idx3));
    }

    #[test]
    fn test_remove_head() {
        let mut arena = Arena::new();
        let mut queue = OrderQueue::new();

        let idx1 = queue.push_back(&mut arena, mock_order(1, 100));
        let idx2 = queue.push_back(&mut arena, mock_order(2, 100));

        let removed = queue.remove(&mut arena, idx1).unwrap();
        assert_eq!(removed.id, 1);

        assert_eq!(queue.head, Some(idx2));
        assert!(arena.get(idx2).unwrap().prev.is_none());
    }

    #[test]
    fn test_remove_tail() {
        let mut arena = Arena::new();
        let mut queue = OrderQueue::new();

        let idx1 = queue.push_back(&mut arena, mock_order(1, 100));
        let idx2 = queue.push_back(&mut arena, mock_order(2, 100));

        let removed = queue.remove(&mut arena, idx2).unwrap();
        assert_eq!(removed.id, 2);

        assert_eq!(queue.tail, Some(idx1));
        assert!(arena.get(idx1).unwrap().next.is_none());
    }
}
