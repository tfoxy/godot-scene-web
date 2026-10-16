### G7f — bounded live decode buffer, conditional (sonnet)

Void if gate 6 fixed D20. Otherwise:

- **Change**: `receiver.gd` live mode decodes each message on its own (or trims consumed bytes and
  rebases `offset`).
- **Checks**: G6s's `soak-scene` `rss-bounded` passes natively. Every live leg of gates 1, 2, 5,
  5.5 and 6 is unchanged.
- **Sabotage**: restoring the append-forever path must fail `rss-bounded` again.

