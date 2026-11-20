import { DEFAULT_CONFIG, type RuleConfig } from "@here-to-slay/engine";
import { useEffect, useRef } from "react";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const onOff = (on: boolean) => (on ? "On" : "Off");

/** Each rule flag (TECHNICAL_DESIGN.md §3.9) in plain words, with its value as a player reads it. */
const SETTINGS: { [K in keyof RuleConfig]: { label: string; value(v: RuleConfig[K]): string } } = {
  actionPointsPerTurn: { label: "Action points per turn", value: String },
  handLimit: { label: "Hand limit at end of turn", value: String },
  startingHandSize: { label: "Starting hand", value: (n) => plural(n, "card") },
  activeMonsterCount: { label: "Monsters face up", value: String },
  monstersToWin: { label: "Monsters to win", value: String },
  classesToWin: { label: "Classes to win", value: String },
  drawAtStartOfTurn: { label: "Free draw at start of turn", value: onOff },
  freeRollOnHeroPlay: { label: "Free roll when a hero is played", value: onOff },
  maxChallengesPerPlay: { label: "Challenges per card played", value: String },
  challengeTieWinner: { label: "A tied Challenge goes to", value: (v) => (v === "challenger" ? "The challenger" : "The challenged player") },
  rollFlagFollowsHero: { label: "A moved hero keeps its roll for the turn", value: onOff },
  itemFollowsStolenHero: { label: "A stolen hero keeps its item", value: onOff },
  leaderCountsForRequirements: { label: "Party Leader counts for monster requirements", value: onOff },
  winCheckTiming: { label: "Wins are checked", value: (v) => (v === "immediate" ? "As soon as they happen" : "At the end of each action") },
  leaderSelection: { label: "Party Leaders", value: (v) => (v === "random" ? "Dealt at random" : "Drafted in Seat order") },
  firstPlayerMethod: {
    label: "First player",
    value: (v) => (v === "roll" ? "Highest roll" : v === "random" ? "Chosen at random" : "The Host"),
  },
  responseWindowMs: { label: "Time to respond online", value: (ms) => `${ms / 1000} seconds` },
  reshuffleDiscardWhenDeckEmpty: { label: "Reshuffle the discard pile when the deck runs out", value: onOff },
};

function settingRows(config: RuleConfig): [label: string, value: string][] {
  return (Object.keys(SETTINGS) as (keyof RuleConfig)[]).map((key) => {
    const setting = SETTINGS[key] as { label: string; value(v: RuleConfig[typeof key]): string };
    return [setting.label, setting.value(config[key])];
  });
}

/**
 * The rules reference (TECHNICAL_DESIGN.md §3, in plain words), shown over
 * whatever is on screen, which stays as it was. Given a game's `config`, it
 * follows that game's rules and lists its settings; without one, the
 * defaults. It only reads: it never sends an action.
 */
export function RulesReference({ config, onClose }: { config?: RuleConfig | undefined; onClose(): void }) {
  const rules = config ?? DEFAULT_CONFIG;
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus goes back where it was, such as the button that opened the reference.
    const before = document.activeElement;
    close.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="rules-backdrop">
      <div role="dialog" aria-modal="true" aria-label="Rules" className="rules-reference">
        <header>
          <h2>Rules</h2>
          <button ref={close} type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {config && (
          <section>
            <h3 id="game-rules">This game's rules</h3>
            <table aria-labelledby="game-rules" className="game-rules">
              <tbody>
                {settingRows(config).map(([label, value]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h3>Setup</h3>
          <ul>
            <li>Everyone is dealt {plural(rules.startingHandSize, "card")} from the main deck.</li>
            <li>
              Everyone gets a Party Leader,{" "}
              {rules.leaderSelection === "random" ? "dealt at random" : "picked in turn, in Seat order, from the ones left"}.
            </li>
            <li>{plural(rules.activeMonsterCount, "monster")} from the monster deck go face up in the middle.</li>
            <li>
              {rules.firstPlayerMethod === "roll"
                ? "Everyone rolls two dice and the highest goes first; players tied for highest roll again."
                : rules.firstPlayerMethod === "random"
                  ? "The first player is chosen at random."
                  : "The Host goes first."}{" "}
              Play then goes clockwise. Nobody can play Modifiers on the roll for first player.
            </li>
          </ul>
        </section>

        <section>
          <h3>Your turn</h3>
          <p>
            {rules.drawAtStartOfTurn && "You draw a card for free, then "}
            {rules.drawAtStartOfTurn ? "you" : "You"} have {plural(rules.actionPointsPerTurn, "action point")} to spend:
          </p>
          <table className="action-costs">
            <tbody>
              {ACTION_COSTS.map(([action, cost]) => (
                <tr key={action}>
                  <th scope="row">{action}</th>
                  <td>{cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul>
            <li>Each hero in your party can try its roll once per turn, whether it works or not.</li>
            <li>An action point is spent when you take the action, even if a Challenge then stops it.</li>
            <li>
              At the end of your turn, if you hold more than {plural(rules.handLimit, "card")}, you discard down to {rules.handLimit}.
            </li>
            {rules.reshuffleDiscardWhenDeckEmpty && <li>When the main deck runs out, the discard pile is shuffled into a new one.</li>}
          </ul>
        </section>

        <section>
          <h3>Cards</h3>
          <dl>
            <dt>Party Leader</dt>
            <dd>Your leader's ability is always on. It can't be stolen, destroyed or sacrificed, and its class counts for your party.</dd>
            <dt>Hero</dt>
            <dd>
              Joins your party. Roll two dice and reach the number on the card to use its effect.
              {rules.freeRollOnHeroPlay && " When you play a hero, you may roll for it straight away, for free."}
            </dd>
            <dt>Item</dt>
            <dd>
              Goes on a hero with no item; each hero holds one at most. If the hero leaves a party, its item is discarded
              {rules.itemFollowsStolenHero ? ", but a stolen hero takes its item along" : ", stolen or not"}.
            </dd>
            <dt>Cursed Item</dt>
            <dd>An item with a bad effect, usually put on someone else's hero.</dd>
            <dt>Mask</dt>
            <dd>An item that makes its hero count as the mask's class, for winning and for monsters.</dd>
            <dt>Magic</dt>
            <dd>Its effect happens at once, then it is discarded.</dd>
            <dt>Modifier</dt>
            <dd>Changes a roll. It costs no action points.</dd>
            <dt>Challenge</dt>
            <dd>Stops a card someone plays. It costs no action points.</dd>
          </dl>
        </section>

        <section>
          <h3>Challenges</h3>
          <ul>
            <li>When anyone plays a Hero, Item or Magic card, the others may Challenge it with a Challenge card.</li>
            <li>
              {rules.maxChallengesPerPlay === 1
                ? "Only one Challenge can be made against each card played."
                : `Up to ${plural(rules.maxChallengesPerPlay, "Challenge")} can be made against each card played.`}
            </li>
            <li>
              The challenger and the player challenged both roll two dice, and the higher total wins; on a tie, the{" "}
              {rules.challengeTieWinner === "challenger" ? "challenger" : "player challenged"} wins. If the challenger wins, the card is
              discarded with no effect.
            </li>
            <li>Challenge and Modifier cards can't be challenged.</li>
          </ul>
        </section>

        <section>
          <h3>Modifiers</h3>
          <ul>
            <li>Anyone, the roller included, may play Modifiers on any roll: a hero's roll, an attack on a monster, or a Challenge roll.</li>
            <li>Each Modifier offers options such as +2 or −2, and the player who plays it picks one.</li>
            <li>Any number of Modifiers can go on the same roll. The total is the dice plus every Modifier on it.</li>
          </ul>
        </section>

        <section>
          <h3>Monsters</h3>
          <ul>
            <li>
              To attack a monster, your party must meet what it needs, such as a number of heroes or a class
              {rules.leaderCountsForRequirements ? ". Your Party Leader's class counts." : ". Your Party Leader's class doesn't count."}
            </li>
            <li>
              Roll two dice. At or above its slay number, you slay it: it joins your slain pile and its ability is yours for good.
              At or below its defeat number, its penalty happens to you. In between, nothing happens.
            </li>
            <li>
              A slain monster is replaced from the monster deck straight away. Once the deck runs out, its slot stays empty, but you can
              still win by classes.
            </li>
          </ul>
        </section>

        <section>
          <h3>Winning</h3>
          <p>
            You win {rules.winCheckTiming === "immediate" ? "at once" : "at the end of the action"}, on anyone's turn, when either is true:
          </p>
          <ul>
            <li>You have slain {plural(rules.monstersToWin, "monster")}.</li>
            <li>Your party, leader included, has {plural(rules.classesToWin, "different class", "different classes")}.</li>
          </ul>
          <p>If both happen together, you win by monsters.</p>
        </section>
      </div>
    </div>
  );
}

const ACTION_COSTS: [action: string, cost: string][] = [
  ["Draw a card", "1 point"],
  ["Play a Hero, Item or Magic card", "1 point"],
  ["Roll for a hero in your party", "1 point"],
  ["Attack a monster", "2 points"],
  ["Discard your hand and draw 5", "3 points"],
  ["End your turn early", "Free"],
];
