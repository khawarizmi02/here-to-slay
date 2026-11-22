# The Host sends its Card Set to friends, without art

Friends open the deployed game page, which is built from the public repo and so has only the placeholder cards. So the Room sends the Host's Card Set to each remote Seat, whether it is local or the placeholder set (one path, and a friend whose page is older or newer than the Host's still sees exactly the Host's cards). It goes in a message of its own: when the friend joins the lobby, and again on every reconnect (a refresh, a `resync`, the Host coming back). It carries the cards' names, text and numbers only. The `art` field is removed before sending, so neither images nor their file names leave the Host's machine. A friend's client always draws cards from the Card Set it received and ignores any set built into its own page. The lobby's Card Set name comes from it too, and shows nothing until it arrives. If the received set fails the same validation as local card files, the client shows an error and does not enter the game. It never falls back to its own cards, because that would quietly show the wrong card text.

## Considered Options

- **Everyone runs a local build with the same local Card Set.** Nothing to build, but every friend needs a copy of the private card files. A mismatch between copies shows wrong text with no error.
- **Send the Card Set only with the first game update.** Rejected because the lobby already names the Card Set, and a reconnecting friend needs it again anyway.
- **Send the art file names too**, so a friend with the same images sees art. Rejected: friends almost never have the images, and sending nothing about art keeps "art stays local" true without exception.

## Consequences

- The real card text passes through the relay in transit, and a friend can read the whole Card Set in their browser. Friends see every card's text on screen during play anyway, and the relay neither parses nor stores messages (ADR-0001).
- The friend's page and the Host's page must agree on the card schema. If the Host's build adds a card field that an older deployed page doesn't know, friends get the load error until the page is redeployed.
- The client looks cards up in the Card Set of the Room it is in, not in a set fixed at build time.
- The whole Card Set is sent on every join and reconnect. It is tens of kilobytes, well under the relay's WebSocket message limit.
