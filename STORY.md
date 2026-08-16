# Slasher Cabin: Some Assembly Required — Story Bible & Script

**Owner:** Story agent. Canonical source for `src/story/Script.js` and `src/story/Panels.js`.
**Version 2.0.** Supersedes v1.0 entirely. v1.0 was a short story about a game. This is a
specification for one.

---

## 0. CONTRACT, DIVISION OF LABOUR, AND WHAT CHANGED

### 0.1 What this document is and is not

This is the **narrative systems** doc. It owns: the fiction, the seven-night beat structure, the
manual's authorship model, the site plan, the prop list, the VO bank, the title cards, and the
endings. It does **not** own the stealth maths, the creak formula, the carry classes, the scoring
formula, or the difficulty tables. Those live in `GAME_DESIGN.md` and are **binding on this
document**.

v1.0 claimed "nothing in this document requires a system that does not exist in
`ARCHITECTURE.md`." That sentence was false. It is deleted. §14 is the honest list of everything
this document needs that does not yet exist, written as diffs another agent can apply.

### 0.2 Who owns which number

| Question | Answered in | Do not re-answer here |
|---|---|---|
| What does a camper do when it sees me? | `GAME_DESIGN.md` §4.3, §8.1 | detection cones, FSM, rally points |
| How long is a night? | `GAME_DESIGN.md` §1.1 (`nightDurationSeconds` 540→1320) | night lengths, stage counts, slot counts |
| What ends a run? | `GAME_DESIGN.md` §8.2 (`night:failed` reasons) | fail reasons, game-over conditions |
| How does a creak work? | `GAME_DESIGN.md` §3.1 (the `lambda` formula) | the formula |
| What does a part weigh? | `GAME_DESIGN.md` §2.1 | mass, carry class, drop noise |
| What is `Score`? | `GAME_DESIGN.md` §9 | the shape and the `satisfaction` formula |
| What colour is anything? | `ART_DIRECTION.md` §2, §8.1 | palette, stroke weights, page spec |
| What does breath sound like? | `AUDIO_DIRECTION.md` §4.19 | the synthesis model |
| How does distance eat a voice? | `AUDIO_DIRECTION.md` §7.2 | the filter chain |

Where this document states a number that also appears in a sibling doc, it is **restating**, not
redefining, and the sibling wins on conflict. Every restatement below is tagged with its source.
This document is written to be read alone by someone who then goes and reads the others; it is not
written to be read *instead of* them.

### 0.3 Cross-document collisions found while writing v2.0 — resolutions

These are real contradictions between shipped docs. Nobody had noticed them. Each one is a
blocking item for a named agent.

| # | Collision | Resolution | Who must change |
|---|---|---|---|
| **C1** | `STORY` v1.0's night-by-night build order (uprights N2, trusses N3, wall panel N5) contradicts `GAME_DESIGN.md` §7 (joists N2, studs N3, trusses N5). | **`GAME_DESIGN.md` §7 wins.** This document's §6 is rebuilt on top of it, beat for beat. The story beats were re-anchored; none were lost. | Story (done, this doc) |
| **C2** | `ART_DIRECTION.md` §8.4 draws the mascot's face as **a hockey mask with three breather holes**. This document's entire reveal is that Ansel's mask is a copy of a *drawing*, not that the drawing is a copy of a hockey mask. | **Blocking. The mascot's face is two filled `1.5 px` dots at 1.42× anatomical spacing. No breather holes, no eye slots, no mouth, ever.** If the figure already reads as Jason on Night One, the game is a pastiche and Night Six has nothing to reveal. See §3.3. | Art agent, `ART_DIRECTION.md` §8.4 |
| **C3** | `ART_DIRECTION.md` §8.6 specifies fake-Swedish product names (`GRÖNSKÄR`, `VÄRNAMO`, `HÄLLESTAD`). The family is **Norwegian** (`VIK & SØN`, `HJEM`). | The assembly names are **real Norwegian building terms**, one per night (§12.1). The joke inverts and improves: a flat-pack manual's product names are meaningless brand words; these are the plain correct words, because a mother naming things for a boy who cannot read does not invent brands. | Art agent, `ART_DIRECTION.md` §8.6 |
| **C4** | `AUDIO_DIRECTION.md` §7.4 names six campers — DENISE, RANDY, TAMMY, KEVIN "SPUD", MARCIA, BUD DIETZ — who are not the six campers in this document. | The **characters** are canonical here (`ARCHITECTURE.md` §9 assigns all narrative to Story). The **voice-parameter columns** are canonical in `AUDIO_DIRECTION.md`. §7.1 below is the mapping table. One profile changes materially: Bev is 58, not 22. | Audio agent, `AUDIO_DIRECTION.md` §7.4 |
| **C5** | `AUDIO_DIRECTION.md` §7.2's `voLP` curve makes any voice past ~50 m inaudible mush, but `GAME_DESIGN.md` §11 opens the game on a laugh at 140 m and this document runs on distant calling. | Add a per-line **`projection`** field. Four values, four filter constants. §14.4. Without it, half the VO bank is unhearable and the atmosphere plan fails silently. | Audio agent |
| **C6** | `ARCHITECTURE.md` §9 gives `CabinSite.js` "the build plot, foundation, slot layout." **Nobody owns the finished interior** — the money shot of the game. | `CabinSite.js` owns it. Ownership line must be amended and budgeted. §10.4. | Engine agent (ownership), Build agent (delivery) |
| **C7** | v1.0's appendix listed beat `n6_bev_remembers` in the order but declared only `n6_robin_inside` on Night Six. | Both are declared on Night Six. Full ordered list in the Appendix. | Story (done) |

### 0.4 Where the v1.0 review was wrong, and why — so this is not "corrected" back

The senior review that prompted this rewrite was right about most things and this document
implements almost all of it. Four items it got wrong, recorded here with reasoning so a later
reader does not helpfully undo the fix:

1. **"The game has no failure model at all" / "no numbers for the core loop" / "no weather
   schedule" / "nothing on accessibility."** These are all specified — in `GAME_DESIGN.md` §8,
   §3.1, §7 and §10 respectively, and in some detail. The reviewer read `STORY.md` in isolation.
   The valid half of the complaint is that *this* document made claims that contradicted them and
   asserted a completeness it did not have. Fixed by §0.2, by restating every load-bearing number
   inline with a citation, and by §6, which is now built on `GAME_DESIGN.md` §7 rather than beside
   it.
2. **"`Score` is never defined anywhere."** It is defined, with a scoring formula, in
   `GAME_DESIGN.md` §9. What is missing is a pointer from `ARCHITECTURE.md` §5, requested in §14.1.
3. **"Dotted outlines must be the game's universal placement affordance from Night One."** No.
   `GAME_DESIGN.md` §2.4 already assigns the dotted outline a meaning: *a part that is present but
   occluded in this view* (grammar G3, taught Night Three). That meaning is strictly better for
   the ending than "a slot." On the last page, the small seated figure drawn in dotted line is not
   an instruction to put something there. It is the manual stating, in its own established
   vocabulary, that **there is a person in that chair and you cannot see her from here.** We do not
   redefine the glyph. The real defect the reviewer identified — that sitting is an untaught verb
   used once as a terminal action — is fixed properly in §13.2: **sit is a taught, mechanically
   useful verb from Night One.**
4. **"The comedy engine is switched off 43% into the game."** The diagnosis was right and the v1.0
   line "the comedy dies here and does not fully return" is deleted. But the fix is not "keep the
   jokes coming." It is: **the form holds for all seven nights and the content curdles inside it.**
   §6 now specifies, for every night without exception, a named missing part, a named location, a
   named comic beat, and a named panel where both tones occupy the same frame (§6.9). Night Seven
   is the funniest night in the game and that is the worst thing about it.

### 0.5 Runtime

The doc previously contained no playtime numbers at all. Derived from `GAME_DESIGN.md` §1.1:

| | N1 | N2 | N3 | N4 | N5 | N6 | N7 | Total |
|---|---|---|---|---|---|---|---|---|
| `nightDurationSeconds` | 540 | 660 | 780 | 900 | 1020 | 1140 | 1320 | **6360 s = 106 min** |
| Slots | 6 | 9 | 14 | 18 | 22 | 20 | 28 | 117 |
| Slots per clock-minute | 0.67 | 0.82 | 1.08 | 1.20 | 1.29 | 1.05 | 1.27 | — |
| Briefing + dawn (clock-free) | 95 s each night | | | | | | | 665 s = 11 min |

**Minimum clean runtime: 1 h 57 m.** Realistic first playthrough, with searching, two failed
nights and the Night Six hunt for a part that does not exist: **3 h 05 m – 3 h 40 m.**

The slots-per-minute curve rises monotonically **except at Night Six**, which deliberately dips to
1.05 — fewer slots, more time. That dip is the design: Night Six is not hard because there is more
work. It is hard because the instructions are wrong and the woods are empty.

### 0.6 The one rule that generates all the others

**The game renders what Ansel can perceive.** He cannot read. Therefore:

- **All printed lexical text in the 3D world renders as grey blur** — a legible *form*, an
  illegible *content*. County notices, camp signs, forms, labels, newspaper. The player sees a
  document and cannot read it, because the man holding the lantern cannot.
- **Numerals, dates and article numbers render sharply.** Marit taught him numbers. He knows
  `1953`. He does not know it is a year.
- **Handwriting renders as shape** — legible as *someone wrote this*, never as words.
- **One word in the game is legible: `HJEM`.** It is on the manual's cover. It is the only word
  his mother ever taught him to read.

This is why there is no world text, no lore collectible and no readable document in the game. Not
as a style rule. As a point of view. Every agent can implement it with one shader branch and one
material flag (`Materials.blurredPrint`), and it is the cheapest characterisation in the project.

---

## 1. PREMISE, THEME, AND THE THING THAT CHANGED IN 1984

### 1.1 The pitch, one sentence

A man is building a house in the woods, at night, from a set of wordless instructions, and he is
doing it correctly.

The comedy is that a slasher-movie monster has a *process* — that he sorts his hardware, that he
reads ahead, that he is annoyed by a missing bracket. The horror is that the process is *good*. He
is not improvising. He is not raving. He measures twice.

Underneath the gag: **this is a story about a man following the last instructions anyone ever gave
him, long past the point where they mean anything.**

**Theme, stated plainly, once, here, and never again anywhere in the game:** grief that has been
given a task will do the task forever. Craft is a way of not stopping. He is patient, careful and
proud, and every one of those virtues is a symptom.

No character says this. No panel draws it. If a line of dialogue in §8 can be summarised by the
paragraph above, cut the line. (Six lines were cut on exactly this test — see §8.2.)

### 1.2 Marit

Ansel Vik cannot read. His mother, Marit, drew him his life instead. How to tie a boot. How to
bank a stove. How to be silent between six and nine when his father was home. She drew in flat,
patient, wordless panels — arrows, numbers, a round-shouldered figure with two dots for a face —
and in the corner of every page she printed a maker's mark, **VIK & SØN**, because a boy who
cannot read school should at least be able to believe he has a trade.

The last thing she ever drew him was a house.

### 1.3 1962

He is not building a murder shack. He is rebuilding the house that stood on this shoreline until
1962, when the Wanaka Pines Land Company condemned it and let the volunteer fire brigade burn it
down as a training exercise, because that was cheaper than demolition. Ansel was thirteen. He
stood in the road with the neighbours and watched men in canvas coats practise putting out his
kitchen.

Marit died that October. There is a burn permit stamped **14 OCT 1962** nailed inside the
boathouse (§9, prop 14) and she is not on it, because she was not a structure.

Camp Wanaka Pines is built on top of where he lived. The mess hall is on the garden. The archery
range is the orchard. The counselors' cabins sit across the footprint of the barn. Nobody there has
done anything wrong. Nobody there knows. That is precisely the problem: they are not villains, they
are *tenants*, and they have no idea the landlord came home.

### 1.4 The inciting incident — why 1984 and not any of the twenty-two years before it

v1.0 had no answer to this, and a slasher with no trigger is a monster rather than a character.
The answer is a piece of orange plastic ribbon.

**In March 1984 the Wanaka Pines Land Company sold the lease.** The camp is being expanded: two
new cabins, a new well, a widened access road. In April, a county surveyor walked the shoreline and
drove **ten steel stakes with orange ribbon** across the point. Four of them stand inside the
footprint of Marit's kitchen. One is in the doorway.

He has drawn this house for twenty-two years and never built it, because it was still there —
under the duff, in the stones, in a shape you could walk. The stakes mean it is about to stop being
there. **He is not starting. He is being evicted a second time.**

This is delivered three ways, all diegetic, none of them narration:

| Channel | Where | First playthrough? |
|---|---|---|
| **Mechanical** | Night One, first player action: the chalked slot for pier P-01 has a county stake standing in it. The player must `build:remove` the stake before the slot becomes snappable. It takes 1.1 s and it is silent. Then they set a pier where it stood. | **Unmissable — it is the tutorial's first input.** |
| **Environmental** | Prop 6: two sets of stakes, visibly different ages, on the same ground. Ten steel-and-ribbon (1984, county). Fifty-one wooden, carpenter's pencil, numbered from 1953 (his). | Passive |
| **Verbal** | `BEV_IDLE_08` and `BEV_LATE_02` (§8). Bev is annoyed about the survey because it means paperwork. | Passive |

The player pulls a government stake out of the ground and builds on the hole. That is the whole
motive, in the first ninety seconds, without a word.

### 1.5 The joke we earn and then take away

For six nights the running gag is **you are always one part short**. On the seventh night the
missing part is a person, and the manual is still doing bits about it, and that is the horror.

---

## 2. ANSEL VIK

**Born 1949. Thirty-five in the summer of 1984.** Nobody in the game says his name. Bev gets to
"His name was—" and stops (§8.11). The only time the player is given the name is the maker's mark
on the final card, wordless and earned.

### 2.1 Silhouette

6'6", 280 lb (127 kg), sloped through the shoulders like a man who has spent his life ducking
through doorframes built for someone else. Canvas coveralls gone black with water. A lumber strap
across the chest. A leather tool roll on the right hip, rolled and tied — never loose, never
rattling. A 28 oz framing hammer with a milled face, carried head-down.

No machete. No blade at all until Night Three, and then only a handsaw, and he hates using it
because it is loud and it dulls.

The manual lives in an oilcloth wallet inside the front of his coveralls, against his chest, where
the rain cannot get it.

Player capsule radius is 0.42 m against a typical 0.30 (`GAME_DESIGN.md` §5.1) — he clips
undergrowth constantly and emits `brush` noise doing it. **He is too big for this forest** and that
is a number, not an animation.

### 2.2 The mask — corrected optics

It is not a mask in the horror sense. It is a portrait.

In his mother's drawings his face was a flat oval with two dots — the way you draw a person when
you are drawing quickly for a child who needs to recognise himself on the page. When the house
burned, the only thing Ansel salvaged was the **porcelain splash-back panel from behind the kitchen
sink.**

v1.0 said he "cut an oval from it and drilled two eyes with a hand brace, and set the eyes too far
apart for a human skull." Both halves of that were wrong. A hand brace on fired glaze shatters it,
and eyeholes wider than the interpupillary distance do not produce a head tilt — they produce
near-total blindness, in a man whose characterisation is millimetre-accurate night carpentry. The
head tilt is the best detail in the fiction and it was resting on a physical impossibility.

**What is actually true, and it is better, because the object causes the gesture instead of the
gesture being asserted:**

| Property | Spec | Consequence |
|---|---|---|
| Material | Fired white glaze on vitreous china, hairline-crazed, 6 mm | Cold, off-white `#e8e4dc`, near-zero roughness in the crazing valleys — it catches the moon at grazing angles and vanishes head-on |
| **It is curved** | It is the sink's splash radius: a section of a 210 mm cylinder | **It cannot sit flat on a face.** It rides proud on the left cheekbone and stands 19 mm off the right. The mask does not fit him and never has |
| Left eye | An oval **nipped**, not drilled — tile nippers, four hours, a chipped scalloped edge you can see from 1 m | Correctly placed. He can see through it |
| Right eye | **Not cut at all.** It is the sink's original factory overflow slot — 26 × 9 mm, off-axis, 31 mm too low | Useless. It looks at his own cheek |
| Therefore | **He sights one-eyed, down the long side of the mask** | He tilts his head and looks along the object the way a carpenter sights down a board to check it for wind |

**That gesture is a craftsman's and a bird's at the same time, and it is now caused.** It is how
the player recognises him in a 1971 photograph on Night Six (§9, prop 16). It is how Robin
describes him, and it is why nobody believes her: "he looks at you sideways" is not a description
of a man.

The rectangle missing from the splash-back is still in the world, on the sink, 60 m from the site,
and the player installs that sink into the kitchen on Night Six (§10.1).

### 2.3 He never speaks — and the breath mix, in numbers

Not a grunt of exertion, not a roar, not a laugh.

v1.0 asked for his breath to be "a tracked emitter at all times so the absence of a voice is
audible" *and* claimed the loudest sound he makes all game is one breath catching on Night Seven.
A payoff cannot compete against six hours of the same signal. Both can be true only with a mix
spec, so here is one. It amends `AUDIO_DIRECTION.md` §4.19 by adding a bus-level filter, not by
changing the synthesis model.

| | Nights 1–6 | Night Seven, one breath |
|---|---|---|
| States in use | `CALM` / `WALK` / `HEAVY` / `FEAR` / `HELD` per `AUDIO_DIRECTION.md` §4.19 | one hand-authored cycle |
| Bus filter | `lowpass f=900, Q=0.5`, always | **filter opens to `f=6000` over 180 ms** |
| Level | `−32 dBFS` ceiling on the `body` bus breath layer | **`−14 dBFS`** |
| Mask colouration | `+6 dB @ 680 Hz`, `−8 dB` shelf above 4 k (§4.19) | **bypassed — the mask is off** |
| Reads as | body. Weight. Not a voice. | **the only unfiltered airway in the game** |

The 900 Hz lowpass is doing the work: it removes every consonant-band component from the breath,
so for six hours the player hears a large mammal and not a person. When it opens once, it is a
person. Nothing else in the mix changes. Do not add music to it.

### 2.4 The habit

**Before he touches the manual, he wipes his hands on his thighs.** Every single time. Two strokes,
palms flat, unhurried — the way you dry your hands before picking up a baby.

He does it when they are wet. He does it when they are muddy. On Night Four he does it when they
are covered in Dale Pruitt, and the animation does not change, and the timing does not change, and
that is the most frightening second in the game, because the priority is not the blood. The
priority is *the paper*.

By Night Seven his hands are split from a week of cold work and the wipe stops working. He marks a
page. He stops. He looks at the mark for 40 frames. Then he turns it anyway.

#### 2.4.1 The wipe's duration is a function of his hands — corrected timing

v1.0 made the wipe a mandatory **0.9 s lockout on every `ui:blueprint-open`**, and estimated the
player would pay it "ninety times." That estimate was out by an order of magnitude. Night Three
alone is 14 slots across 4 stages; realistic opens across a playthrough are **380–780**. At 0.9 s
that is six to twelve minutes of watching an animation, applied to the tightest feedback loop in
the game (check diagram → check join → check diagram).

The idea was never "make the player wait." The idea was **his hands**. So the duration is his
hands:

```js
// BlueprintUI.js. Reads Player.handState (new read-only property, §14.1).
handState: 'dry' | 'wet' | 'muddy' | 'bloodied' | 'split'

wipeDuration =
    0.18                                   // baseline: this IS the page-unfold in ART_DIRECTION §8.7
  + (isFirstOpenOfNight        ? 0.72 : 0) // 0.90 s
  + (handState !== lastWipedState ? 0.72 : 0) // 0.90 s
  + (night === 7 && handState === 'split' ? 1.22 : 0) // 1.40 s, once
```

| Situation | Duration | Times per playthrough |
|---|---|---|
| Ordinary open | **0.18 s** | ~370–770 |
| First open of a night | 0.90 s | 7 |
| First open after hands change state | 0.90 s | ~9 |
| **Night Four, first open after Dale** | **0.90 s**, animation and timing identical | 1 |
| **Night Seven, hands split** | **1.40 s**, and it fails | 1 |

Total animation time across a full playthrough: **≈ 82 seconds**, against v1.0's implied 6–12
minutes. The payoff survives; the loop does not die.

**The lockout lives in `BlueprintUI.js` (UI agent), not `BuildSystem`.** `HUD` emits
`ui:blueprint-open`; `BlueprintUI` plays the wipe; `BlueprintUI` emits `ui:blueprint-ready` when
the page is legible (§14.1). Nothing else may gate on `ui:blueprint-open`.

**The world does not pause while the manual is open.** `GAME_DESIGN.md` §2.4 states this and it is
load-bearing for the horror: you are reading a piece of paper with your back to a forest. Say it in
every doc. There is no "manual stays pinned" toggle at `standard` difficulty because the manual
*does* stay open while walking at `story` and `standard` (`GAME_DESIGN.md` §10.1) — only `gristle`
makes you stop.

### 2.5 Why he builds

Because he was told to be quiet and useful, and the instructions did not end, and no one ever came
to check the work.

---

## 3. THE MANUAL AS NARRATOR

The manual is the only character in this game with a personality, a sense of humour and an opinion.
It has no words. It has an *attitude*, expressed entirely through what it bothers to draw, the
mascot, the warnings, the article numbers, and **the linework itself.**

One word appears in the entire game: the cover reads **HJEM**. The player parses it as a flat-pack
product name, the way you parse KALLAX. It is not a product name (§0.6).

### 3.1 The linework tell — the actual narrative device

There are two hands in this manual and the player is never told this.

- **Marit's hand:** single confident stroke, closed corners, even weight, the figure drawn with
  rounded shoulders and a slight forward lean, as if listening.
- **Ansel's hand:** doubled-back lines, over-corrected corners, visible erasure ghosts, the figure
  drawn *taller*, shoulders square, no lean.

The manual does not "get darker." **Ansel starts drawing the pages he needs it to say.**

| Night | Panels in Ansel's hand | Cumulative |
|---|---|---|
| 1 | 0 of 9 | 0% |
| 2 | 1 of 11 | 4% |
| 3 | 2 of 14 | 5% |
| 4 | 5 of 16 | 16% |
| 5 | 9 of 18 | **31%** |
| 6 | 13 of 17 | **59%** |
| 7 | 1 of 1 (the fold-out's telephone inset) — every other mark is hers, and the last mark she ever made | — |

### 3.2 `authorship` as a four-parameter struct — the tech spec

v1.0 asked `Blueprint.js` to "expose `authorship` as a per-panel field driving line jitter, stroke
doubling and eraser ghosting in the procedural diagram generator," which is a subordinate clause
describing a specialist's year of work, and it is the entire narrative device. Here is a spec that
a Build agent can implement in a week.

**Panels are parametric stroke lists**, not images:

```js
Stroke = {
  pts:      Float32Array,   // [x0,y0, x1,y1, ...] in page units (page height = 900)
  weight:   'hairline'|'thin'|'medium'|'heavy',  // ART_DIRECTION §8.2 — 0.75/1.5/2.5/4.0 px
  closed:   bool,
  seed:     int,            // per-stroke, from Rand — deterministic per ARCHITECTURE §6
}
Panel = { id:'6.8', strokes:[Stroke], authorship:'marit'|'ansel', hero:bool }
```

**`authorship` is a struct of four numbers plus three derived ones.** These are the shipping
values; a balance pass changes only this object.

```js
const HANDS = {
  marit: {
    wobbleAmp:       0.22,  // px of perpendicular deviation, page-height 900
    cornerOvershoot: 0.00,  // px past the vertex before the turn
    strokeRepeat:    1.00,  // expected passes per stroke
    ghostAlpha:      0.00,  // alpha of erased strokes left under the final line
    // derived
    wobbleFreq:      0.9,   // cycles per 100 px of arc length
    pressureVar:     0.06,  // ± fraction of nominal weight along the stroke
    closureError:    0.0,   // px gap at a closed corner
  },
  ansel: {
    wobbleAmp:       0.95,
    cornerOvershoot: 1.80,
    strokeRepeat:    1.70,  // 70% of strokes doubled, offset 0.6–1.4 px, second pass at 0.72 alpha
    ghostAlpha:      0.14,
    wobbleFreq:      3.4,
    pressureVar:     0.28,
    closureError:    0.9,
  },
};
```

`wobbleAmp` and `wobbleFreq` drive a 1-D value-noise offset along each stroke's normal, seeded from
`Stroke.seed` so a panel is identical every time it is drawn. `cornerOvershoot` extends the
incoming segment past the vertex before the outgoing segment starts — the single most legible
"drawn by someone who is trying hard" tell. `strokeRepeat > 1` re-draws the stroke with a
per-pass offset. `ghostAlpha` draws a discarded variant underneath at that alpha, at
`weight − 1` step.

**Nobody has to consciously read this.** The one panel where the difference must be *conspicuous*
is 5.4, and 5.4 is hand-authored (§3.5).

### 3.3 The figure

Internal id **`BJØRN`** (Norwegian Ø, correcting `ART_DIRECTION.md` §8.6's Swedish Ö). Never shown
to the player. Construction per `ART_DIRECTION.md` §8.4 — 4.0 px continuous outline, head a perfect
`3U` circle, 4.5 heads tall, `#14181a` on `#f2efe6`, hammer grip the only red — **with one blocking
correction and one addition:**

| | `ART_DIRECTION.md` §8.4 says | Corrected |
|---|---|---|
| Face | "A hockey mask… three `1.5 px` breather holes in a triangle and two `1.5 px` almond eye slots" | **Two filled `1.5 px` dots. Spacing `1.42×` anatomical. Nothing else. No mouth, ever, except Panel 2.6.** |
| Why | — | If the drawing already looks like a hockey mask, the mask is a reference to a movie instead of a copy of a drawing, and Night Six reveals nothing. The whole fiction runs backwards through this one detail. **This is C2 and it is blocking.** |
| Poses | 9 fixed poses | **Add exactly one: `arms-at-sides`.** It is used twice in the game: Panel 6.9, and Ending A. |

`ART_DIRECTION.md` §8.4's comic rule stands and is the engine of the whole thing: **BJØRN is never
in danger and never reacts to anything frightening.** A camper's silhouette may appear in a panel;
BJØRN carries on. The horror is in the diagram and the diagram does not care.

### 3.4 Baking — zero panel renders per frame

| Step | When | Cost |
|---|---|---|
| Build stroke lists for the night | `night:begin` | < 4 ms, no allocation in `update()` |
| Rasterise **one** page to an `OffscreenCanvas` at **1448 × 2048** (A4 1:1.414, ≥ 2× the 62%-of-viewport display size in `ART_DIRECTION.md` §8.1) | on demand | 6–9 ms |
| Cache | at most **3** baked pages (current, previous, next) = **35.6 MB** | — |
| Re-bake on page turn | during the 0.30 s page-turn animation | 6–9 ms, amortised |
| Per-frame canvas draws | **zero** — the DOM layer shows the baked bitmap | 0 |
| Dispose | `night:complete` | — |

Do not bake all pages up front: 14 pages × 11.9 MB is 166 MB of texture memory for a piece of
paper. Paper fibre, fold creases and the drop shadow (`ART_DIRECTION.md` §8.1) are CSS/canvas
layers composited over the bitmap, not baked into it.

**Ending A's "the panel updates in real time" is not a live generator.** Both states — the panel,
and the panel with the red diagonal — are baked at Night Seven's `night:begin`. The "redraw" is a
0.9 s crossfade plus a 0.6 s `clip-path` reveal animated along the diagonal's own stroke path. Two
bitmaps and a CSS animation.

### 3.5 Hand-authored hero panels — the carve-out

`ARCHITECTURE.md` §1 mandates **zero binary art assets**. Several of the most important panels in
the game are drawings, not generatable diagrams, and nobody had noticed the collision.

**The carve-out:** hero panels ship as **code-authored stroke data** — JS arrays of polylines with
per-vertex pressure — in a new Story-owned file, `src/story/Panels.js` (§14.2). This is legal under
the no-binary-assets rule: it is source code, it diffs, it has no fetch.

**Exactly nine panels are hand-authored. Everything else is procedural.**

| Panel | What it is | Hand | Strokes (budget) |
|---|---|---|---|
| `0.0` | The cover. **HJEM**, the house in three-quarter elevation, `VIK & SØN` | marit | 210 |
| `1.9` | The contents inset — and the boot (§6.9) | marit | 96 |
| `4.9` | The figure standing over a horizontal shape with shoes, dimensioned `1.78 m` | ansel | 78 |
| `5.4` | The second figure: erased, redrawn, erased, redrawn smaller. Three ghosts under the final line | marit, then ansel over it | 190 |
| `5.7` | The counterweight, drawn as a dotted standing human outline, with the "approximate" tilde and **no number** | ansel | 64 |
| `6.5` | Article `0000-000`, confident arrow, empty slot | ansel | 44 |
| `6.8` | The kitchen wall elevation: window over a sink, four pencil marks on a doorframe — with a bunk bed drawn over it in a second hand and erased | marit + ansel | **340** |
| `6.9` | The figure, alone, centre of an empty page, `arms-at-sides` | ansel | 52 |
| `7.1` | The fold-out. Every step ticked. Parts bracket: `1`. The telephone icon, and the payphone drawn *in situ* 160 m away, with a dotted path | marit — **except the telephone inset, which is ansel** | 520 |

Total hand-authored stroke budget: **1,594 strokes ≈ 46 KB of source.** That is one focused week,
not a specialist's year.

**Typography.** `ART_DIRECTION.md` §8.6 already specifies a CSS stack with fallbacks, so the
reviewer's "resolves to Arial on Windows" is half-answered. The remaining risk is *metrics*, and
the manual's typography is the comedy. Two guards:

1. **Metric probe at init.** `BlueprintUI` measures the advance width of `HAMBURGEFONS` at 100 px
   in the resolved font. Reference (Helvetica Neue Medium): **704.0 px**. If the measured value
   differs by more than 1.5%, apply compensating `letter-spacing` and a `transform: scaleX()`
   clamped to ±3%. Log via `Log.debug`.
2. **Nothing large is type.** The cover word, the seven assembly names, and the night-end card
   headline are **stroke data**, not text. Total font failure cannot break the joke; it can only
   make three-character part codes slightly wide.

### 3.6 The seven-stage evolution

**Night 1 — HELPFUL.** Warm, over-explains, delighted with you.
> *1.1:* the figure waving, both hands, from the corner of the page.
> *1.4:* a bolt going into a hole. Then the same bolt, larger. Then the same bolt again with a
> magnifier over it, in case you missed the bolt.
> *1.7:* the figure standing on the finished foundation, `thumbs-up`, one drawn sparkle.

**Night 2 — PEDANTIC.** It has decided you're competent and now it's fussy.
> *2.3:* a bracket at 90°, ticked. The same bracket at 88°, ✗ in red. The same bracket at 89.5°,
> **also** ✗ in red.
> *2.6:* a hand tightening a bolt, with the spiral-torque arrow. Then the same hand,
> over-tightened, and the figure with one flat line for a mouth. **The figure has never had a
> mouth. He does not have one again for five nights, and the next time is Ending A.**

**Night 3 — IMPATIENT.** Steps get combined. It skips things.
> *3.2:* eleven sub-assemblies collapsed into one drawing with fourteen arrows and no intermediate
> states. Good luck.
> *3.5:* an entire step rendered as one downward arrow and `×6`.
> *3.8:* the figure, `standing-neutral`, with three motion ticks beside one foot. It is tapping.
> It is waiting for you. **First time the manual is a presence and not a document.**

**Night 4 — KNOWING.** It begins illustrating things it should not know about.
> *4.1:* the hinge you need, in isolation. Then *in situ* — screwed to the camp boathouse door,
> drawn correctly, including the oar propped against it. **The manual knows where the camp is.**
> *4.6:* a cone of light on the ground. The figure outside the cone. A ghost-trail dotted path.
> First panel that is about *them* and not about the house.
> *4.9:* **hero.** The figure standing over a horizontal shape. The shape is not a joist. It has
> shoes, and a double-headed dimension arrow reading `1.78 m`. The manual measured him.

**Night 5 — COMPLICIT.** It stops pretending this is only carpentry.
> *5.1:* the standard warning icon — **THIS STEP REQUIRES TWO PERSONS** — two figures, one at each
> heel of a truss. Both in Marit's hand. Both drawn twenty-two years ago.
> *5.4:* **hero.** The second figure, erased, redrawn, erased, redrawn smaller. Three ghosts under
> the final line. No arrows, no numbers, no instruction. **It should not be in a manual at all.**
> *5.7:* **hero.** The counterweight diagram. The counterweight is a **dotted outline of a standing
> person** with the "approximate" tilde and no number at all (§6.5.1 explains why the number is
> gone and why that is better).

**Night 6 — WRONG.** Not sinister-wrong. *Broken*-wrong, which is worse.
> *6.2:* step 14 before step 9. Step 9 does not appear.
> *6.5:* **hero.** Article `0000-000`, a confident arrow, an empty slot. It is not in the world. It
> has never been in the world. The slot it points at is beside the kitchen table.
> *6.8:* **hero.** A kitchen wall elevation in perfect Marit line — a window over a sink, four
> pencil marks on a doorframe at ascending heights — and drawn over the top of it in Ansel's
> scratched hand, a **bunk bed**. He is trying to make his mother's house fit a camp. It doesn't.
> He erases the bunk. The ghost stays at `ghostAlpha 0.14`.
> *6.9:* **hero.** The figure, alone, centre of an empty page, `arms-at-sides`. Not doing anything.

**Night 7 — GONE.** `BlueprintUI` opens to a blank spread. The wipe still plays. It takes 1.40 s
and it does not work.
> *7.1:* **hero, fold-out.** Every step of the house, ticked, in her hand. In the parts bracket:
> `1`. Beside it, in *his* hand, the telephone icon — the parody "contact customer service" — and
> the camp payphone drawn *in situ*, 160 m away, correct to the alcove, with a dotted ghost-trail
> path from the front door to it.
> The last page: a **dotted outline** of a small seated figure, in a chair, at a table.
> Child-sized. Marit's hand, 1962, on the last page she finished. Dotted, in this manual's
> established grammar (`GAME_DESIGN.md` §2.4, G3), means: **present, but occluded in this view.**
> Above it, the parts bracket, and inside the bracket, nothing.
> **Some assembly required.**

---

## 4. THE SITE — one plan, from which every distance in the game derives

v1.0 contained eleven distances chosen one at a time and most of them were "about eighty metres."
Here is the plan they should have come from. **`Terrain.js`, `Forest.js`, `Navmesh.js`,
`Props.js`, `CabinSite.js` and `NoiseSystem.js` all read these numbers.**

### 4.1 Playable area

| Property | Value | Why |
|---|---|---|
| Extent | **448 m (E–W) × 384 m (N–S)** = 17.2 ha | Fog far plane is 140 m (`ART_DIRECTION.md` §5) — you never see more than a third of it. Big enough that the camp is a rumour; small enough for one navmesh |
| Heightfield | 449 × 385 vertices, **1.0 m spacing**, `Float32Array` 692 KB | One chunk grid of 7 × 6 chunks at 64 m; `Forest` instances per chunk |
| Origin / datum | **The centre of the Vik house ruin footprint**, `(0, 0, 0)` | Every story object is placed relative to the house, because everything is |
| Axes | `+X` east, `+Z` south, `Y` up (`−Z` forward per `ARCHITECTURE.md` §2) | |
| Boundaries | N: the lake. S: the county road at `Z = +186`. W: the ridge crest at `X = −130` (+19 m). E: marsh at `X > +196` | Four different kinds of "you can't go that way," none of them a wall |
| Elevation range | −2 m (shoreline) to +19 m (ridge) | The ridge is where `skylineFraction` gets you killed (`GAME_DESIGN.md` §4.1) |

### 4.2 Landmark table — the single source of truth for positions

| # | Landmark | X | Z | Dist. from datum | Bearing | Tier |
|---|---|---|---|---|---|---|
| 1 | **Ruin footprint / build site** (11.6 × 7.8 m, long axis E–W) | 0 | 0 | **0** | — | — |
| 2 | Rest stump + folded blanket + tin cup | +7 | +9 | 11.4 | SE | — |
| 3 | The birch with four notches | −9 | +12 | 15.0 | SSW | — |
| 4 | Brass survey marker, 1962 | +16 | +15 | 21.9 | SE | — |
| 5 | Supply pallet | −14 | +26 | 29.5 | SSW | **1** |
| 6 | Fallen log — pier 6, the mallet, the 1961 plate | −26 | −18 | 31.6 | NW | **1** |
| 7 | Fire road, nearest point | +45 | 0 | 45.0 | E | — |
| 8 | **The dock** (1962, his) | −28 | −41 | 49.6 | NNW | — |
| 9 | Woodpile (shims) | −36 | +46 | 58.4 | SW | **2** |
| 10 | The porcelain sink, against a birch | −52 | −30 | 60.0 | WNW | **2** |
| 11 | **Canoe rack — nearest lit camp edge** | +68 | +22 | 71.5 | ESE | **2** |
| 12 | The lean-to (the boot, on its shelf) | −74 | −22 | 77.2 | WNW | **2** |
| 13 | **Boathouse** | +86 | −52 | 100.5 | ENE | **2** |
| 14 | The grave — a mowed rectangle (+14 m elev.) | −112 | +34 | 117.0 | WSW | — |
| 15 | Tool shed | +118 | +40 | 124.6 | ESE | **3** |
| 16 | Archery range (the orchard) | +58 | +112 | 126.1 | SSE | **3** |
| 17 | Ridge crest | −130 | 0 | 130.0 | W | — |
| 18 | Counselors' cabins (the barn footprint) | +104 | +96 | 141.6 | SE | **3** |
| 19 | **Mess hall** (the garden) | +132 | +74 | 151.3 | ESE | **3** |
| 20 | Camp office porch — Bev's chair, hubcap ashtray | +146 | +60 | 157.9 | ESE | **3** |
| 21 | **Payphone alcove** | +138 | +82 | 160.6 | ESE | **3** |
| 22 | County road (nearest point) | +20 | +186 | 186.0 | S | — |
| 23 | Camp entrance sign — **which is his front door** | +96 | +178 | 202.2 | SSE | — |

Spawn tiers now *derive* instead of being asserted: `GAME_DESIGN.md` §2.5 defines Tier 1 as
20–45 m, Tier 2 as 60–110 m, Tier 3 as 120–190 m. Every landmark above lands in its stated tier.
The supply pallet is 29.5 m, the boathouse is 100.5 m, the mess hall is 151.3 m. Nothing was
rounded to fit.

### 4.3 Distance matrix

| | Site | Canoe rack | Boathouse | Mess hall | Payphone | Dock | County rd |
|---|---|---|---|---|---|---|---|
| **Site** | — | 71.5 | 100.5 | 151.3 | 160.6 | 49.6 | 186.0 |
| **Canoe rack** | 71.5 | — | 76.2 | 82.5 | 90.0 | 111.0 | 164.4 |
| **Boathouse** | 100.5 | 76.2 | — | 134.1 | 138.0 | 114.5 | 242.4 |
| **Mess hall** | 151.3 | 82.5 | 134.1 | — | 10.0 | 190.5 | 112.0 |
| **Payphone** | 160.6 | 90.0 | 138.0 | 10.0 | — | 200.0 | 104.0 |
| **Dock** | 49.6 | 111.0 | 114.5 | 190.5 | 200.0 | — | 227.6 |

### 4.4 Numbers re-derived from the plan

Everything below was an arbitrary number in v1.0 and is now a consequence.

| Thing | v1.0 | v2.0 | Derivation |
|---|---|---|---|
| **The saw's noise radius (Night Three)** | "radius 90 m" (asserted) | **90 m — and now it means something** | 90 m from the datum reaches the fire road (45), the dock (49.6), the canoe rack (71.5). It does **not** reach the boathouse (100.5), the mess hall (151.3) or the payphone (160.6). **Robin hears the saw. Bev cannot.** That is Night Three's entire argument, and it is geometry |
| Robin's torch sweeping the frame (N2) | "at eighty metres" | **71.5 m**, from the canoe rack | Landmark 11 |
| The boathouse is "inside the lit perimeter" | "ninety metres inside" | **29 m inside the lamp line**, 100.5 m from the site, 76.2 m from the canoe rack | Landmarks 11, 13 |
| Dale, Night One | "four hundred metres off" | **impossible** — the map is 448 m wide and fog far is 140 m. Corrected: Night One's single counselor runs a fixed loop whose **closest approach to the plot is 31 m**, at `(+32, +12)`, every **96 s**. His singing is heard at 96–140 m | `GAME_DESIGN.md` §7: "on a fixed loop that never reaches the plot." 31 m is not reaching it |
| The scripted first creak (`GAME_DESIGN.md` §11, t=4:39) | camper "reacts" at unstated range | Creak severity 0.45 → radius `14 + 46×0.45 =` **34.7 m**. Scripted to fire on the loop's 31 m approach | `GAME_DESIGN.md` §3.1 |
| The sink | "60 m from the site" | **60.0 m** | Landmark 10 |
| The 1961 plate shim | "30 m east" | **31.6 m NW**, at the fallen log — the same log as pier 6 and the mallet in `GAME_DESIGN.md` §11 | Landmark 6. One trip, three finds, the joke lands three times |
| The grave | "forty metres uphill" | **117.0 m WSW**, on the ridge shoulder, +14 m | Landmark 14. Far enough that finding it is an expedition |
| Dale's torch, moved on Night Seven | "eleven metres" | **8.5 m**, from the stump at `(+46, −4)` to `(+38, −7)` — *toward the house* | §9, prop 12 |
| Bev's chair faces | "the point where the house used to be" | bearing **293°** from `(+146, +60)`, which is the datum | Landmarks 1, 20 |

### 4.5 The name of the lake

"Lake Wanaka Pines," Minnesota, 1984. **Wanaka is a Māori place name from Otago, New Zealand.** It
is not a Minnesota toponym and it does not belong to any regional Dakota or Ojibwe naming pattern.

We are keeping it, because **the fakeness is the point and it is now load-bearing:**

> The Wanaka Pines Land Company invented the name in **1958**, from a travel brochure, because it
> sounded outdoorsy and it sold lots. The brochure is still in a file tin in the boathouse (§9,
> prop 15) with photographs of a lake in Otago that is not this lake. The name is stamped on the
> 1962 brass survey marker that Ansel polishes.

**We do not invent an Ojibwe or Dakota name for what it was called before.** Two reasons, and both
must survive future edits:

1. We are not qualified to coin one, and a plausible-sounding fake Indigenous toponym invented by
   a game studio is precisely the act the fiction is criticising. We would be the Land Company.
2. The erasure *is* the fact. On the 1958 plat in the boathouse tin the older name is under the
   Land Company's overprint and is not recoverable. The game refuses to supply what the Land
   Company took, and it refuses on camera.

A company renamed a lake to sell it, then condemned a house on it, then rented the ground to
children. Ansel is the fourth thing on that list.

---

## 5. THE WEATHER SCHEDULE — the difficulty curve, as a table

Wind sets how often the player's mistakes are published to the AI. It *is* the difficulty knob and
v1.0 had no table. This restates `GAME_DESIGN.md` §7's weather column, adds gust structure, and
computes the consequence.

**Method.** `GAME_DESIGN.md` §3.1: `lambda = 6.0·(w + 0.30s)·(0.40 + 0.90L)·Mw·Mt·Md` creaks/min.
The reference case below is **one Rotated join** (`w = 0.35`), perfectly torqued (`s = 0`), at
rated load (`L = 1.0`), no creak debt (`Md = 1`), at mid-night (`Mt = 1.25`). That gives a constant
`3.4125 × Mw`, with `Mw = 1 + 0.60·wind + 0.20·rain`.

`maskFloor = 0.30·rain` (`GAME_DESIGN.md` §3.3). "Heard" is `lambda × (1 − effective mask)`.

| Night | Rain | Wind base | Gust amp | Gust period | Fog | Strikes | `Mw` | λ / min (1 wrong join) | Effective mask | **Heard / min** | What it feels like |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **1** | 0.00 | 0.05 | — | — | 0.20 | 0 | 1.03 | 3.52 | 0.00 | **3.5** | Still. Clear. Your mistake is the only sound in the county |
| **2** | 0.00 | 0.25 | 0.18 | 28 s | 0.30 | 0 | 1.15 | 3.92 | 0.00 | **3.9** | The trees move. Nothing covers you |
| **3** | 0.40 | 0.35 | 0.25 | 22 s | 0.45 | 1 | 1.29 | 4.40 | 0.12 | **3.9** | First rain. First mercy. It is not much |
| **4** | 0.60 | 0.40 | 0.30 | 18 s | 0.55 | 2 | 1.36 | 4.64 | 0.18 | **3.8** | Wet. Loud world. The best night to be loud in |
| **5** | 0.70 | 0.75 | 0.45 | 11 s | 0.40 | **6** | 1.59 | 5.42 | 0.26 | **4.0** | Storm. Thunder masking is mandatory (`GAME_DESIGN.md` §7). You hammer on the count |
| **6** | **0.00** | **0.20** | **0.04** | **90 s** | **0.80** | **0** | 1.12 | 3.82 | **0.00** | **3.8, every one of them heard** | **Dead air.** Fog to 0.80 and not a breath of wind. Nothing hides you and nothing hides them |
| **7a** (`t < 0.8`) | 0.55 | 0.65 | 0.50 | 9 s | 0.35 | 4 | 1.50 | 5.12 | 0.17 | 4.3 | The storm breaking |
| **7b** (`t ≥ 0.8`) | 0.00 | 0.03 | 0.00 | — | 0.25 | 0 | 1.02 | 4.04 (`Mt` = 1.45) | **0.00** | **4.0, in silence** | It stops raining. **The last 20% of the game has zero masking** (`GAME_DESIGN.md` §7) |

**The headline the table makes visible:** raw creak rate barely moves across the game (3.5 → 5.4).
What collapses is *cover*. Nights Three through Five give you weather to hide in and teach you to
rely on it; Night Six takes it away without changing anything else, and Night Seven takes it away
mid-sentence.

**Night Six's wind is 0.20 with a gust amplitude of 0.04 and a 90-second period.** That satisfies
`GAME_DESIGN.md` §7's stated `wind 0.2` while being, in practice, dead still — one slow breath of
air a minute and a half. `Weather.js` must not treat 0.20 as "light breeze" and generate ordinary
gust structure on Night Six. This is the single most important line in the weather schedule.

---

## 6. THE SEVEN NIGHTS

Rebuilt on `GAME_DESIGN.md` §7's build schedule (collision **C1**). Escalation runs on three
independent curves — **build complexity**, **camper density**, and **tone** — and they are
deliberately out of phase. Night Four spikes tone before it spikes density. Night Six drops
density to two and is the worst night in the game.

### 6.0 Master table

| | **N1** | **N2** | **N3** | **N4** | **N5** | **N6** | **N7** |
|---|---|---|---|---|---|---|---|
| **Assembly name** | GRUNNMUR | BJELKELAG | REISVERK | KLEDNING | TAKSTOL | VINDU & DØR | HJEM |
| **Build target** (`GAME_DESIGN.md` §7) | 6 piers + sill beams | 9 floor joists | 14 studs + corner posts | 18 sheathing panels | 22 trusses + purlins | 20 glazing, door, hinges, **sink, doorframe** | 28: hearth stone, porch, roof cap, **two chairs** |
| Stages / slots / seconds | 3 / 6 / 540 | 3 / 9 / 660 | 4 / 14 / 780 | 4 / 18 / 900 | 5 / 22 / 1020 | 5 / 20 / 1140 | 6 / 28 / 1320 |
| **Grammar introduced** | G1 axonometric | G2 mirroring | G3 hidden parts | G4 ambiguous scale | G5 sequence | G6 errata | G7 continuation + all |
| **Named missing part** | the **mallet** (+ pier 6) | **4 L-brackets** | **2 gusset plates** (+ the saw problem) | **1 sheathing board** + the **hand brace** | **3 truss pins** + tallow (+ **a second person**) | **errata slip** + **hinge set** + a short bag (+ **article `0000-000`**) | Tier-3 item + errata slip + a bag short by 3 (+ **a person**) |
| **Named location** | fallen log, 31.6 m NW | woodpile, 58.4 m SW | boathouse eave, 100.5 m ENE | mess hall, 151.3 m ESE / the **boathouse door leaf** | counselor's truck, 141.6 m SE | boathouse **again**, 100.5 m | payphone alcove, 160.6 m ESE |
| Campers | 1 | 2 | 3 | 4 | 5 | **2** | 7 + Ranger |
| Weather (§5) | still, clear | wind 0.25 | rain 0.40 | rain 0.60 | **storm** | **dead air, fog 0.80** | storm → **dead calm** |
| Beat id | `n1_thumbs_up` | `n2_robin_hears` | `n3_not_believed` | `n4_dale` | `n5_two_persons` | `n6_robin_inside`, `n6_bev_remembers` | `n7_final` |
| Panels in Ansel's hand | 0/9 | 1/11 | 2/14 | 5/16 | 9/18 | 13/17 | the telephone |

---

### NIGHT ONE — **GRUNNMUR** — *FOUNDATION (A)*
*Beats:* `n1_stake_pulled`, `n1_thumbs_up` · *Flags:* `pulledCountyStake`, `foundPlateShim`,
`sawIntroPanel`

**Build.** Six stone piers, six sill beams, twenty-four lag bolts. Two-part join, generous snap
tolerance (0.65 m / 28°, `GAME_DESIGN.md` §2.2), forgiving torque. The first five minutes are
scripted beat-for-beat in `GAME_DESIGN.md` §11 and this document does not contradict a single line
of it. Two additions only, both at the front:

**t = 0:38 — the inciting incident, as an input.** The chalked square for pier **P-01** has a
county survey stake standing in it: 12 mm steel rod, orange plastic ribbon, driven in April.
`CabinSite` marks P-01 unsnappable while the stake is present. The player must `build:remove` it:
**1.1 s, silent, no prompt, no toast.** The ghost preview for the pier is drawn at 15% opacity in
`#d92b2b` until it clears — the game's existing "dependency not met" language (`GAME_DESIGN.md`
§2.2), used here for its only non-structural dependency in the whole game.

Then they set a stone where it stood. Flag `pulledCountyStake`. Nine more ribboned stakes remain
standing across the point for the rest of the game, and the player will walk past them ninety times.

**Missing.** The **mallet** — Tier 1, at the fallen log, 31.6 m NW, half-buried beside the sixth
pier (`GAME_DESIGN.md` §7, §11 at 2:40). *The joke lands twice: the player did not know they were
missing a mallet, because they had been using their hands.*

**The third thing at the log — the shim.** Pier D seats 11 mm low. The manual's fix panel (1.6) is
a rectangle with an arrow into a gap. It does not care what the rectangle is. Lying under the log
is a **1961 Minnesota licence plate, folded in three.** It is a class-A consumable, silent, 2.5 s
to place, `s −= 0.35` (`GAME_DESIGN.md` §3.3). It fits perfectly. It has always been the shim. It
was under the old house too. Flag `foundPlateShim` → the manual redraws the fix panel's red outline
in black with a tick.

**The comic beat: THE MAGNIFIER.** Panel 1.4 draws a bolt going into a hole. Then the same bolt,
larger. Then the same bolt again, with a magnifier over it. Three panels, one bolt. The manual
thinks you might not have got it.

**The collision panel — 1.9 (hero).** The contents inset: six piers and six beams on a pallet,
drawn in dimetric, each with an article number. At the pallet's edge, drawn to the same scale, with
the same care, in the same hand: **a boot.** Size 3. No article number. No arrow. It is in the
contents.

**What goes wrong.** Nothing. Genuinely nothing. He gets it right, and the player laughs at a
monster doing homework, and that is the last time the game is only funny.

**Taught this night:** carry, place, torque-hold, the creak, crouch (discovered, not instructed —
`GAME_DESIGN.md` §11 at 3:20), **and sit** (§13.2). The rest stump at 11.4 m SE has a wide flat
seat; sitting on it regenerates stamina at 19.0/s against 11.0 standing. Most players will sit on
it in the first ten minutes because they are exhausted and it is the only comfortable-looking thing
in the forest. Beside it, on a smaller stump, a **folded blanket and a tin cup**, brushed off,
dry. That seat is not sittable. The game refuses it silently — no ghost, no prompt, no toast — for
six nights.

**Closing image.** Rain has not started yet. Six piers, dead level. The spirit level's bubble is
centred and the manual's last panel is the little masked figure standing on the foundation with
both arms up. Behind him, at the frame's edge, nine orange ribbons in a line.

**Night-end card headline:** `ASSEMBLY REPORT — GRUNNMUR — STEP 1 OF 7`. Figure posture:
`thumbs-up`.

---

### NIGHT TWO — **BJELKELAG** — *UPRIGHTS (B ×4), SUPPORT WHILE FIXING*
*Beat:* `n2_robin_hears` · *Flags:* `robinSuspicious`

**Build.** Nine floor joists across the sill. **Order matters now** — G2 mirroring: the manual
draws the *left* bay only, with the mirror glyph, and the right bay is its reflection with bracket
handedness flipped (`GAME_DESIGN.md` §2.4).

**Missing.** **Four L-brackets, three supplied.** Tier 2 — the woodpile at 58.4 m SW, in a coffee
can, under a tarp that is holding six litres of rainwater.

**The comic beat: THE MANUAL COUNTS FOR YOU, SMUGLY.** v1.0 said "the player will count them three
times," which is a prediction, not a design. It is not how the game works: `GAME_DESIGN.md` §2.5
says the manifest flags the shortfall in red **at t = 0**. So the joke is not that you discover the
shortfall. The joke is the *presentation*: the parts-list panel draws four brackets in a neat row,
numbers them `H-1 H-2 H-3 H-4`, and then puts a red outline and a 40 × 40 m contour inset around
the fourth one, as though the manual has always known, as though this is a normal thing for a
manual to do, as though somewhere a Norwegian woman in 1962 wrote "and the fourth one is in the
woods."

**The collision panel — 2.7.** The `THIS STEP REQUIRES TWO PERSONS` icon appears for the first
time. Two figures, one at each end of a joist. The second figure has no hammer, no tool roll, and
is drawn at **0.62× scale.** It is not an adult. Nobody remarks on it. It will be back on Night
Five, and on Night Five it will have been erased three times.

**What goes wrong.** The mirrored bay. Joist **J-06** goes in handed wrong — `Rotated`, `w = 0.35`
(`GAME_DESIGN.md` §2.3). It seats. It sits 6 mm proud. And it **rings** instead of knocking (§13.3)
on every hammer tap, from the moment it goes in, and the player has been hearing dead-flat knocks
for a night and a half.

Then the wind gets to it: 0.25 base, 0.18 gusts, 28-second period. **3.9 creaks per minute, and
nothing to mask them** (§5).

**New mechanic.** Noise and light. `NoiseSystem` propagation, flashlight cones, crouch, LOS break.
First real `player:spotted` risk — and what that *means* is in §6.10 and it is not a reload.

**Story beat — `n2_robin_hears`.** Robin Osei-Hall, alone at the canoe rack at **71.5 m**, hears a
mallet. Four strikes, even, spaced. She stops moving. `ROB_HEAR_01` → `ROB_HEAR_03`. Flag
`robinSuspicious`; from Night Three, `Campers` adds the plot to her patrol graph.

She has heard ten thousand hours of tools in her father's boatyard. **She is right for a technical
reason nobody else on site can evaluate**, and that is her whole tragedy.

**Closing image.** Her torch beam crawls over the frame at 71.5 m, holds on it for a second and a
half, and moves on. She does not understand what she is looking at, because it is a house, and
there is not supposed to be a house.

**Night-end card:** `BJELKELAG`. Posture `standing-neutral` unless she never heard you, in which
case `thumbs-up`.

---

### NIGHT THREE — **REISVERK** — *DO NOT OVERTIGHTEN*
*Beat:* `n3_not_believed` · *Flags:* `robinDismissed`, `cutTheGroundSill`

**Build.** Fourteen wall studs and four corner posts. G3: the bag icon says eight gussets, the
drawing shows six. Two are behind the visible geometry and the player must reason about occlusion
in the axonometric to find where (`GAME_DESIGN.md` §2.4).

**Missing.** **Two gusset plates**, Tier 2, on the boathouse eave at 100.5 m ENE — reachable
without entering the lit perimeter, but you have to stand on Dale's ladder to get them, and the
ladder is against the boathouse, and the boathouse has a window.

**The second problem, which is not a missing part: THE SAW.** The ground rises **340 mm** across
the footprint from the south-west corner to the north-east. It always did; the old house was built
to it. The corner posts ship at a uniform 2.4 m. Post **C-NE must be cut to 2.06 m.** Nothing is
missing. The piece is *too long*, which is worse, because you cannot go and find your way out of
it.

The handsaw is in the tool roll and has been since Night One.

**Cutting is the loudest sustained thing in the game.** `noise:emit { kind:'saw', radius: 90,
intensity: 0.55 }`, re-emitted every 0.5 s for the duration of the cut (§14.1 — `saw` is a new
`kind`). A full cut is **31 seconds** of it. You must break it into passes between patrols.

**The comedy is that you cannot rush a saw.** A 127 kg man who can shoulder a 62 kg beam is
completely hostage to the physics of a saw blade, and the game gives him no way to be strong at it.
Push harder and the blade binds: the cut rate *drops* 40% and the pitch goes up 300 Hz. The only
technique is patience, which is the one thing that costs time, which is the one currency
(`GAME_DESIGN.md` §6.3).

**And 90 m is exactly the right number** (§4.4): the saw reaches the fire road, the dock and the
canoe rack. It does not reach the boathouse, the mess hall or the payphone. **Robin hears it. Bev,
151 m away in the office, cannot.** Night Three's argument is decided by acoustics before anyone
opens their mouth.

**The collision panel — 3.6.** The cut panel. A hand, a board, a cut line, and the standard
double-headed dimension arrow measuring the board against **the figure's own forearm** — a
carpenter's trick, and a mother's, and completely charming. Then the same forearm drawn again
beside it at **0.55× scale**, with the same measurement on it. She measured him against the board
in 1957 and wrote the number down. The forearm grew. The number didn't.

**New mechanic.** Sustained-noise budgeting. Class-D hauling. Shims. **The grab** (`GAME_DESIGN.md`
§8.3) — 4.5 s of contact from behind an unaware camper, silent, and it creates three problems, one
of which is that from the next stage onward the manual quietly adds a small figure in the corner of
every page: BJØRN, standing, with a red slash-circle over a second small figure. It is a safety
warning. It is never acknowledged.

**Story beat — `n3_not_believed`.** Robin tells Bev about the mallet. Bev tells her that sound
carries across the water from the state campground, six kilometres, that it happens every year, and
that it is usually a generator. `BEV_ARG_02`.

**Bev is not being dismissive. Bev is being correct about a thing that is usually true.** The first
cruelty in the script is committed by the campers, gently, to each other, out of ordinary
competence. Dale could corroborate — he heard it too, from the shed — and he doesn't, because
corroborating means a report, and a report means the county, and the county means his job.
`DAL_ARG_01`. Flag `robinDismissed`: from Night Four, Robin patrols alone, because she has stopped
telling people.

**Closing image.** Bev at the treeline with a cigarette, deciding whether to walk out and look —
**cut.** That image (a held ember, eleven seconds) is the smoking-veteran-who-almost-investigates
beat from every one of these films since 1979 and we are not doing it.

Instead: **the woodpile tarp.** Robin walks back past it at 02:50 and it is folded. Not thrown
back — folded, in three, and squared to the woodpile's edge, because a man who needed a coffee can
out from under it put the tarp back the way a tarp goes back. She looks at it for two seconds. She
does not know what is wrong with it. Nothing is wrong with it. That is what is wrong with it.

**Night-end card:** `REISVERK`. New line, deadpan: `CUTS MADE ON SITE — 1`. `WE WOULD PREFER
YOU DID NOT.`

---

### NIGHT FOUR — **KLEDNING** — *IF PARTS ARE MISSING, DO NOT RETURN TO STORE*
*Beat:* `n4_dale` · *Flags:* `tookBoathouseDoor`, `firstBlood`

**Build.** Eighteen sheathing panels. G4 ambiguous scale: two boards differ only in length —
2.4 m and 2.6 m — and **no dimensions are printed anywhere on the sheet.** The only scale reference
on the page is BJØRN, who is 1.7 m, which is the player's own eye height, which means the player
must measure a drawing against their own body and then measure a board against their own body.
Getting it wrong seats fine and floats at the far end and is not discovered until Stage 4.

**Missing — two, per `GAME_DESIGN.md` §2.5.**

1. **The hand brace.** Tier 3, mess hall shelf, **151.3 m ESE**, two campers in the room, one of
   them static. The most dangerous errand in the first four nights. (It is also the tool he used to
   drill nothing, because you cannot drill fired glaze — §2.2.)
2. **One sheathing board**, 0.2 × 2.4 m, milled. And there is no milled lumber in a forest.

**Where the board is: the boathouse door.** It is the only milled panel of that dimension inside
1 km. It is 100.5 m ENE, hung on **three good brass hinges**, 29 m inside the lamp line.

He takes the **door leaf**. He leaves the hinges on the frame, because the manual did not ask for
hinges, and he is not a thief, he is short a part.

Consequence persists permanently: `tookBoathouseDoor`. `Props.js` removes the leaf for the rest of
the game; the frame stands empty; the campers prop the gap with an oar and never fix it. On Night
Six he comes back for the hinges, off the same frame, and that escalation is the whole reason the
door and the hinges are two nights apart instead of one.

**The comic beat: THE MANUAL KNOWS WHERE THE CAMP IS.** Panel 4.1 draws the part he needs in
isolation — and then draws it *in situ*, screwed to a door, correctly, including the oar propped
against it. The manual has never been to the camp. The manual was finished in 1962. The manual
drew the oar.

**The collision panel — 4.9 (hero).** BJØRN, `standing-neutral`, over a horizontal shape. The shape
is not a joist: it has shoes. A double-headed dimension arrow runs its length: **`1.78 m`**. The
manual measured him. There is no red mark, no warning lozenge, no exclamation. It is a dimension.
It is drawn with exactly the care every other dimension in the manual is drawn with.

**Story beat — `n4_dale`.** Dale Pruitt walks up the fire road to piss at 01:20 and finds a house
that was not there in June. He is not scared. He is *confused*. He says
`DAL_EVID_04` — "…the hell is this, chief" — out loud, to nobody, and then he reaches out and
**knocks on it, twice, politely**, the way you knock on a thing to see if it's real.

The first kill is off camera. One hard cut to black. No music sting, no scream, no impact sound.
The only thing on the audio bus is a hammer being **set down carefully on wood** — the
`join_seat` sample, the sound the game has spent three nights teaching the player means *correct*.

`firstBlood` → `Player.handState = 'bloodied'`. The next `ui:blueprint-open` therefore costs
**0.90 s** (§2.4.1), and the animation is byte-identical to Night One's, and the timing is
identical, and the priority is the paper.

**Emotional turn.** v1.0 said "the comedy dies here and does not fully return." That line is
deleted (§0.4.4). The comedy does not die. **The campers stop being funny on purpose and start
being funny by accident**, which is unbearable, and the manual goes on doing bits for three more
nights without breaking stride.

**Closing image.** v1.0 used Dale's torch on the ground, still lit, rolling in a slow quarter-arc —
which is every slasher film since 1980, and which is worse than the version this document already
contained in its own prop list.

**The real closing image: the torch stood upright on a stump, lens-up, still on.** Because he
needed both hands, and there was a stump, and you put a light where it will be useful. It throws a
20 m cone straight up into the rain. It is on for the whole of Night Five and most of Night Six,
browning as the battery dies, and it is visible from the canoe rack, and nobody comes.

**Night-end card:** `KLEDNING`. And, for the first time, one extra line, last, in `#d92b2b`:
`PLEASE ASSEMBLE ALONE.` (`GAME_DESIGN.md` §9 already specifies this line at any kill count > 0.
Night Four is where it first appears and nobody should soften it.)

---

### NIGHT FIVE — **TAKSTOL** — *THIS STEP REQUIRES TWO PERSONS*
*Beat:* `n5_two_persons` · *Flags:* `riggedTruss`, `sawSecondFigure`

**Build.** Twenty-two roof trusses and purlins. Ladder, height, **skyline exposure** — standing on
the top plate sets `skylineFraction` toward 1.0 and a lightning flash forces `exposeF = 2.0` for
0.25 s (`GAME_DESIGN.md` §4.1). The storm you are hammering under is the storm that silhouettes
you.

**Weather: the storm.** wind 0.75, rain 0.70, **6 strikes** (§5). Thunder masking stops being a
trick and becomes the schedule: 8 truss joins × 6 taps is 48 discrete `hammer` emits at radius 34,
and `Weather.nextStrikeIn()` is the only reason any of them are survivable.

**Missing.** Three truss pins and a tallow tin, Tier 3, in the counselor's truck bed at 141.6 m SE
(`GAME_DESIGN.md` §7). Standard errand, at the worst possible time, in the rain.

**And the fourth missing thing, which is not a part.**

#### 6.5.1 THIS STEP REQUIRES TWO PERSONS — corrected from mass to geometry

v1.0's version: a 4.8 m wall panel of mass 71 kg that `Physics` "refuses" to let one man place.
That fails on contact with the fiction. Ansel is 127 kg and has spent four nights solo-shouldering
62 kg beams and 55 kg trusses. **A 71 kg panel is a shrug for him**, every player will feel the
game refusing for narrative reasons, and the beat dies. Worse: v1.0's Panel 5.7 put `71 kg` on the
counterweight too, so the number the doc wanted read as *a person's weight* was trivially
explained as *the panel's weight*, and the reveal defused itself.

**The obstacle is geometry. Nothing in this game is ever prevented by the player being too weak.**

Truss **T-01** is the first truss up. Every later truss ties to the one before it through a purlin;
T-01 has nothing to tie to. It is a 4.0 m span (`GAME_DESIGN.md` §2.1) and to pin it:

| Requirement | Value | Ansel |
|---|---|---|
| Must be held within | **±2° of plumb** | — |
| At two points, separated by | **4.1 m** (heel to heel) | — |
| While the ridge pin is driven — 4 taps, 2.4 s | both hands | — |
| **His reach, fingertip to fingertip** | — | **1.9 m** |

`Physics` does not refuse anything. The player *can* pick it up, *can* stand it, and it *falls*,
every time, because holding one heel plumb rotates the other out past 2° in 1.4 s and there is no
third arm. The failure is legible, physical, repeatable, and completely fair, and every player will
try it at least twice.

**The solution is rigging.** Multi-object physical assembly with **no snap points and no correct
answer, only a working one**: Dale's canoe, a rope, the fallen log, the ladder, a stump. Ballast is
the lake's own stones, and the player has to keep adding them until it holds — the game never
states a mass and never will. `build:place` fires with `correct: true` for a join the manual never
specified. **It is the only time in the game that happens**, and it is the first thing Ansel builds
that his mother did not draw. Flag `riggedTruss`.

**The collision panel — 5.7 (hero).** The counterweight diagram. The counterweight is drawn as a
**dotted outline of a standing person**, with the flat-pack "approximate" tilde beside it, and
**no number at all.**

Not `71 kg`. Not any number. Two reasons, both load-bearing:

1. A number invites arithmetic and arithmetic defuses it. An empty box beside a human outline is
   the manual being *polite*, and politeness about this is the joke and the horror in the same
   mark.
2. The dotted outline of a person is planted **here**, on Night Five, in the manual's established
   G3 grammar — *present, but occluded in this view*. When the last page of the game shows a small
   seated figure in dotted line, it is the second time the player has seen the manual do this, not
   the first (§0.4.3).

**The comic beat: THE MANUAL IS UNHELPFUL IN THE EXACT REGISTER OF A REAL MANUAL.** Panel 5.1 is
the genuine flat-pack safety icon — two little men, one at each end, `THIS STEP REQUIRES TWO
PERSONS` — and every human being who has ever assembled furniture alone has laughed bitterly at
that icon, and the game is counting on it, and it is the last time the joke is only a joke.

**Story beat — `n5_two_persons`.** Panel **5.4 (hero)**. The player opens the manual to check a
purlin spacing, lands on 5.4, and there is no measurement on the page.

The second figure. Drawn in Marit's hand. Erased. Redrawn. Erased. Redrawn smaller. Three eraser
ghosts visible under the final line at `ghostAlpha 0.14`. No arrows, no numbers, no step badge, no
instruction. **It should not be in a manual at all.** Flag `sawSecondFigure`.

She drew the house for two people and then spent an afternoon in 1962 trying to work out how big to
make the other one, and could not decide, and made him smaller each time.

**Story beat, quiet.** Marg organises a proper search in pairs rather than a panic — `MRG_SRCH_01`.
Nobody goes anywhere alone after Dale. The forest gets *harder* because the campers got
*competent*, and that is the correct direction for this game to escalate in.

**Closing image.** The truss stands. Ansel puts one hand flat on the bottom chord and leaves it
there four seconds longer than the animation needs — no music, no camera move, no zoom. Rain.

The other end is held up by a canoe full of stones.

**Night-end card:** `TAKSTOL`. New line, and it is the funniest and worst line on any card:
`IMPROVISATION — NOTED.`

---

### NIGHT SIX — **VINDU & DØR** — *SOLD SEPARATELY*
*Beats:* `n6_robin_inside`, `n6_bev_remembers` · *Flags:* `foundErrata`, `tookBoathouseHinges`,
`installedSink`, `markedDoorframe`, `usedRuinAnchors`, `robinSaw`, `bevRemembered`

**The twenty slots.** 11 glazing units `GL-01…11`, the doorframe `DF-01`, the door leaf `DR-01`,
the hinge set `HG-01`, the **sink `SK-01`**, the stove flue `FL-01`, and **four pencil marks
`PM-01…04`** (§10.3). Twenty slots in 1140 seconds — the only night in the game where the
slots-per-minute curve goes *down* (§0.5). There is more time and less work and it is the worst
night, and that is the design.

**Weather: dead air.** Rain 0.00, wind 0.20 at gust amplitude 0.04 on a 90-second period, fog
0.80, **zero lightning strikes** (§5). Effective mask: **0.00.** Every creak the player has ever
built is audible tonight and there is nothing at all to hide behind.

**Campers: two.** The camp has called the county. Five of them are at the road, 186 m south,
waiting on headlights that take four hours (`BEV_LATE_01`). The woods are the emptiest they have
been since Night One, and the emptiness is not relief.

#### The manual is broken

Not sinister-broken. *Wrong*-broken. G6, deliberate errata (`GAME_DESIGN.md` §2.4):

- Panel 6.2 runs step 14 before step 9. **Step 9 does not appear anywhere on the sheet.**
- The wall elevation contradicts the floor plan by 340 mm — the same 340 mm he sawed off on Night
  Three, which means one of these two drawings was made before he cut it and one after, which means
  he drew one of them.
- Panel **6.5 (hero)** gives article **`0000-000`** with a confident straight-insert arrow into an
  empty slot beside the kitchen table.

#### `0000-000` — the part that does not exist, and the clock that does

**It is not in the world. It has never been in the world.** v1.0 said "the game will let you look
for it for as long as you like," which directly contradicts the premise of the game and
`GAME_DESIGN.md` §1.1's `timeOfNight`. **The night has a clock. Looking for it costs you the
night.** If the player insists, dawn arrives, `night:failed { reason: 'dawn' }` fires, and the
unbuilt slots roll into Night Seven's budget (`GAME_DESIGN.md` §8.2). The doc is not going to lie
about this to protect a joke.

**The diegetic failsafe**, tied to `tool:missing { toolId: 'part_0000_000' }`:

| t after `tool:missing` | What happens | Channel |
|---|---|---|
| 0 s | Manifest shows `0000-000` red-outlined with a contour inset. **The inset is blank.** There is no region, because there is no place | `BlueprintUI` |
| **180 s** | Ground fog begins settling *into the old foundation trench.* The ruin's footprint starts drawing itself in white, 300 mm deep | `VolumetricFog`, `CabinSite.ruinAnchors` |
| **240 s** | The trench line closes — a continuous luminous rectangle, 11.6 × 7.8 m, visible from anywhere on the plot. `BuildSystem` begins accepting placements validated against `CabinSite.ruinAnchors` instead of the diagram. Flag `usedRuinAnchors` | Build |
| **300 s** | Fog fills to 600 mm. From the roof it is a floor plan. From the ground it is weather | Render |

**To finish this night the player must stop reading and start remembering** — and the mechanic is
also the thesis, and it costs nothing to implement because the anchors already exist.

**Correction to v1.0:** the ruin stones are **not** "visible only when the lantern rakes across at
a low angle." They are visible from Night One, always, in every light. He cleared this site weeks
before the game starts; the stones sit proud of the duff, black at the edges, and
`GAME_DESIGN.md` §11's chalked squares at t=0:14 **are chalked onto them.** The player places their
first pier on a burned foundation stone in the first two minutes of the game. What Night Six
reveals is not that the stones are *there*. It is what they are *for*.

**Missing — three named parts, three named locations, one errand.**

1. **The errata slip.** Tier 2, in the boathouse, in a **cardboard box under the canoe rack.**
2. **The hinge set.** Off the boathouse door frame — the same frame he stripped the leaf from on
   Night Four, which the camp propped with an oar and never fixed.
3. **A fastener bag short by three.**

#### The box

The Land Company cleared the Vik house in 1962 and boxed its papers and the box went into the
boathouse and has been under the canoe rack for twenty-two years, holding it level.

Inside: a 1958 Land Company travel brochure with photographs of a lake in Otago (§9, prop 15). A
plat sheet with a name overprinted. And a single loose page in Marit's hand, folded in three —
**the real step 9.**

The player does not know what any of it is. To the game, and to the manual, and to the man, it is a
**red-outlined manifest item**, and when he picks it up the bell rings (`hardware_chime`,
`GAME_DESIGN.md` §2.5) and the red outline redraws in black with a tick, and `BlueprintUI` stamps
the correction over Panel 6.2, and Ansel puts his mother's handwriting in his coveralls and goes
back to work.

Flag `foundErrata`. If the player never finds it, building as printed produces a join that can never
exceed `w = 0.35` (`GAME_DESIGN.md` §2.4) — the door hangs wrong for the rest of the game and it
creaks in the last scene.

**The comic beat: THE MANUAL IS CONFIDENTLY, SERENELY INCORRECT.** It is not lying. It is not
taunting. It has an article number for a thing that does not exist and it is *sure* about it, and
the arrow is drawn at exactly the same 4.0 px weight as every arrow that has ever been right. That
is the single most accurate thing in this game about assembling furniture.

#### Story beat one — `n6_robin_inside`

Gated on `markedDoorframe` (§10.3) and `installedSink` (§10.1) — the player must have built both
before this fires, because both are what she finds.

**Where the player is: on the ladder at the gable, mid-hold on glazing unit `GL-11`.**

Glazing is not a 2.2 s torque check. A glazing unit is bedded and pinned: **a committed hold of
9.0 seconds** with both hands, on a ladder, 4.2 m up. `GAME_DESIGN.md` §2.1: a window unit is
18 kg, class C, and its drop noise is **0.90 — the loudest drop in the entire table, because it is
glass.**

The player *can* let go. Nothing stops them. Eighteen kilograms of glass goes through the roof into
the kitchen. The game does not warn them, because it does not need to: they have known what glass
does since Night One.

Robin comes in at **t = +1.2 s** into the hold.

For **nine seconds the player physically cannot act**, and it is not a cutscene and control is
never taken — it is bedding compound, and it is the same 9.0 s hold the player has performed ten
times already tonight. In those nine seconds: her torch crosses the floor he laid. It stops on the
sink. It stops on the window over the sink. It goes to the doorframe.

Then the hold completes, and the player has **complete freedom for the remaining 104 seconds**, and
there is exactly one way down off the gable, and it is the ladder, and the ladder comes down into
the kitchen three metres from her.

**The game measures nothing here and judges nothing.** If the player climbs down, Robin is in
`Curious`, she sees him at 3 m, and it resolves through the ordinary FSM with no special case and
no scripting. Most players will not climb down. The reason they don't is the reason he doesn't, and
the game never says so.

What she finds, in this order: `ROB_LATE_01` (pencil marks on the doorframe), `ROB_LATE_02`
(reading four numbers aloud — she thinks they are measurements; they are years), `ROB_LATE_04`
("There's no nails in this. There's no *nails* in it."). She puts her hand flat on the top mark.

**It is above her head.**

Flag `robinSaw`. She walks out. She is not attacked.

#### Story beat two — `n6_bev_remembers`

Bev, at the county road at 186 m, in the headlights of her own truck, says the thing she has been
circling for three nights: `BEV_LATE_02`, `BEV_LATE_03`, `BEV_LATE_04`.

> **"His name was—"**

And she stops. Because saying it makes it a person, and she has spent thirteen years not doing
that.

**v1.0 had her say "His name was Ansel V—", fifteen lines after the doc claimed nobody says his
name in the game.** The full first name was in the line. It is cut. She stops before the first
syllable, and the only identification anywhere in the game is Robin's "he looks at you sideways,"
and the name arrives once, wordless, on the last card, as a maker's mark. Flag `bevRemembered`.

**Bev's arithmetic, corrected.** She says **"Thirteen summers"** (`BEV_IDLE_02`) and **"Thirteen
years. Never. Not once"** (`BEV_FEAR_01`). She has been here since **1971**; 1984 − 1971 = 13.
Twenty-two is the number of years since the fire and it belongs to the *land*, not to Bev — v1.0
had pasted it into her mouth twice. The gap is the point: **she inherited a story that started nine
years before she got here and she has never once gone and looked at it.** Panel 5.1's "both drawn
twenty-two years ago" is correct and stays.

**Emotional turn.** The audience knows everything. Ansel knows nothing. The gap is the horror.

**Closing image.** Not "a shadow across the window that does not move" — that is a jump-scare
composition with the scare deleted and it would waste the best night in the game.

**The closing image is a sound.** He is on the gable. She walks out through the door he framed. And
he hears her boots go across his floor, through his wall, muffled and clear, arriving late — and it
is *exactly* how a correctly built wall carries sound, and he built it, and it works.

Hold on his hands on the batten. Fifteen seconds. No music.

That acoustic fact is planted here so that it can end the game at 06:15 on Night Seven.

**Night-end card:** `VINDU & DØR`. `PARTS SUPPLIED: 19 OF 20.` `PLEASE CONTACT CUSTOMER SERVICE.`
Figure posture: `head-tilt-confused`.

---

### NIGHT SEVEN — **HJEM** — *SOME ASSEMBLY REQUIRED*
*Beat:* `n7_final` · *Flags:* `builtBothChairs`, `manualBlank`, `ending_a | ending_b | ending_c`

**Build: twenty-eight slots, and the house is not finished when the night starts.** v1.0 said
"nothing structural remains," which throws away the best night in the schedule and contradicts
`GAME_DESIGN.md` §7. It is wrong. Night Seven is the biggest build in the game:

| Slots | What |
|---|---|
| 1 | **The hearth stone.** 140 kg, **class E — the only part in the game that must be dragged** (`GAME_DESIGN.md` §2.1). Continuous `drag` noise, radius 22, every 0.5 s, 0.34× speed, from the shoreline at 34 m. It takes 100 seconds and every one of them is audible |
| 6 | Chimney courses |
| 8 | Porch: two posts, beam, four deck boards |
| 9 | Roof cap and ridge flashing |
| 2 | **The table, and the chair** — `CH-A`, adult |
| **1** | **`CH-B` — the small chair** |
| 1 | The deferred slot from Night Six (G7) |

**All seven grammars, on one fold-out sheet** (`GAME_DESIGN.md` §7). Including **G7**: a slot was
deliberately left open at the end of Night Six with the manual reading "see fig. 4b," and fig. 4b is
on tonight's sheet, and **leaving it open across the night boundary was correct.** A player who
tidily filled it on Night Six put a wrong part into the load-bearing ridge and has a permanent
`w = 1.00` join over the kitchen.

**Missing — three, per `GAME_DESIGN.md` §2.5: one Tier-3 item, one errata slip, one fastener bag
short by three.** All three are ordinary. All three are findable. The player will get all three.

**And the fourth thing, which is not on the manifest.**

#### The fold-out — Panel 7.1 (hero)

Every step of the house, ticked, in Marit's hand.

In the parts bracket: **`1`**.

Beside it, drawn in **Ansel's** hand — doubled lines, overshot corners, `ghostAlpha 0.14` — the
**telephone icon**: the parody "if any parts are missing, contact customer service." And beneath it
the camp payphone, drawn *in situ*, correct to the alcove and the wall lamp, **160 metres away**,
with a dotted ghost-trail path leading from the front door to it.

`GAME_DESIGN.md` §2.4 already establishes the telephone glyph and already says that learning it
means the camp payphone is a Night Six story beat. This is the payoff: **the manual is telling him
to go and get someone, and the manual is telling him in his own handwriting.**

The horror is not that the manual has turned on him. The manual has not changed at all. **He wrote
that panel.** He has been extrapolating from a dead woman's instructions for twenty-two years, and
this is what the extrapolation produces, and it looks exactly like an instruction because he made
it look exactly like an instruction.

#### The comic beat, and it is the funniest in the game

**Customer service.**

A man has built a house from a flat-pack manual, he is one part short, and the manual tells him to
contact customer service, and he goes.

#### The house

`timeOfNight 0.8` — **03:40.** The rain stops. Wind drops to 0.03. Dead calm, zero masking, for the
last 20% of the night (`GAME_DESIGN.md` §7). It is the first time in the game the world is quiet.

The player walks the interior with `hud:mode 'none'` (§14.1) — no reticle, no prompts, no objective,
no creak feedback, no toast. `settings.subtitles` still works. Nothing speaks.

**The floor does not creak anywhere.** The player has spent seven nights learning what a creak
means, and the total absence of one is more frightening than any sound the game has made. If the
player built badly, it *does* creak, and every wrong join is in the room with them, and the game
does not comment. That is the seven-night payoff of `state.installed` persisting `correct` and
`torque` (§6.8) — **the last scene of the game is a report card you spent a week writing.**

Every surface is correct. A sink with a window over it. A stove flue. A doorframe with four pencil
marks in his own hand at 91, 108, 124 and 141 cm. A table.

**Two chairs.**

**Night-end card:** there isn't one. See §12.3.

The endings are §11.

---

### 6.8 Build errors persist — the record of your reading comprehension

`GAME_DESIGN.md` §7 already states this and it is the best idea available to this premise, so this
document leans on it hard rather than repeating v1.0's mistake of describing a wrong join on Night
Two and then forgetting about it on Night Three.

**`state.installed[slotId] = { partId, correct, torque }` persists for the whole game.** A Rotated
joist from Night Two is still Rotated on Night Seven, still 6 mm proud, still ringing under the
hammer, still creaking. `creakDebt` carries 40% overnight. The cabin is a record.

**And later nights read earlier work.** Three specified back-references, each of which can send the
player back into their own past at three in the morning:

| Night | Reads | If it's wrong |
|---|---|---|
| **N3** | The sill beams (N1) must be within **2.0°** of level for the corner posts to reach their `requires` | Post ghosts refuse. Player must `build:remove` a sill beam (8 s, `wrench` noise 0.45) and re-seat it |
| **N5** | The north corner posts (N3) must be within **1.5° of plumb** or truss T-01 cannot be held inside its ±2° window at all — the rig will not converge no matter how many stones go in the canoe | **The player must go back and re-plumb Night Three's work, in a storm, on Night Five.** The game's only backtrack is a man fixing his own mistakes |
| **N6** | `DF-01`'s jamb must be within **1.0°** or the four pencil marks land at the wrong heights and the manual redraws them, in his hand, wrong | He copies the numbers anyway |

**The positive-correctness channel exists and it is not the creak** (§13.3). The creak is negative,
delayed, and gated on wind. The immediate, positive, every-single-tap signal is the **knock**: a
fully seated join knocks dead and dry; a proud one **rings**.

### 6.9 The seven collision panels — one per night, individually specified

The reviewer was right that Panel 4.9 was the only place in v1.0 where both tones occupied the same
frame. There are now seven. This is the index; the panels themselves are specified in §3.5/§3.6 and
authored in `src/story/Panels.js`.

| Night | Panel | The comedy | The horror | Same mark? |
|---|---|---|---|---|
| 1 | **1.9** | A flat-pack contents inset. Six piers, six beams, article numbers, dimetric, tidy | A child's boot, size 3, drawn to scale, in the contents, with no article number | Yes — it is *inventory* |
| 2 | **2.7** | `THIS STEP REQUIRES TWO PERSONS`. Everyone has laughed at this icon | The second person has no tools and is drawn at 0.62× scale | Yes — the icon *is* the child |
| 3 | **3.6** | Measuring a board against your own forearm — a real carpenter's trick, and charming | The same forearm, drawn again at 0.55×, carrying the same measurement | Yes — the measurement is the mark |
| 4 | **4.9** | Nothing about this panel breaks form. It is a dimension | The dimensioned object has shoes and is 1.78 m | Yes — the dimension arrow |
| 5 | **5.7** | A counterweight box with a tilde. Flat-pack vagueness, perfectly observed | The counterweight is a dotted human outline and the box is empty | Yes — the empty box |
| 6 | **6.5** | `0000-000`. Every person who has ever assembled furniture knows this rage | The slot it points at is beside the kitchen table and it is chair-shaped | Yes — the arrow |
| 7 | **7.1** | *Contact customer service.* | *Contact customer service.* | **It is one mark. It was always one mark.** |

### 6.10 What being seen actually does — the story layer over `GAME_DESIGN.md` §8

`GAME_DESIGN.md` §8.1 owns the escalation ladder, the suspicion arithmetic and the `night:failed`
reasons. **Being seen is never a game over and never a reload.** What this document adds is what
the *world* looks like afterwards, because the consequence must be visible on the house and not on
a meter.

| Rung | `GAME_DESIGN.md` §8.1 mechanical effect | **The world change this document specifies** |
|---|---|---|
| 1 | 3 investigations, campers pair up | Torches sweep wider. Nothing on the site changes |
| 2 | `player:spotted` once, suspicion +0.25 | **A camp lantern is left burning on the fire road at 45 m, permanently, from the next night.** They have started lighting the dark *toward* the site. `lum` floor +0.09 within 30 m of it |
| 3 | A report delivered, camp lights come on | **Orange ribbon appears on the four county stakes nearest the plot.** Somebody walked out here in daylight and flagged it |
| 4 | 2 reports or a body found; kids recalled | The woods go silent. `Forest`'s bird layer stops for the rest of the game |
| 5 | 3 reports; the Ranger's truck arrives | **The truck parks on the dock.** He fixed that dock in 1962 for nothing and it is the best-built thing at this camp and there is a county vehicle on it |
| 6 | Radio call completes → `night:failed { reason:'reported' }`, next night at suspicion 0.45 and one fewer stage | **The plot is taped.** Four ribbons strung between the county stakes, and a printed county notice stapled to the pine at `(+6, −3)`. Every slot inside the tape is unsnappable until the player pulls the ribbons — **4 × 1.1 s, silent, no prompt** — which is the same input, at the same cost, as the very first thing they did in the game |

**The notice is unreadable.** It renders as a form: a grey blur with a county seal, a legible date,
and a legible number. **He cannot read it** (§0.6). The single most expensive consequence in the
game arrives as a piece of paper that the man it is about cannot understand, and the player cannot
either, because the player is him.

Once taped, taped. Pulled ribbons stay pulled; a new report re-tapes.

**And what a `phase: 'chase'` is.** `ARCHITECTURE.md` §8 allows the value and v1.0 never said what
it meant. **Ansel does not chase.** `phase: 'chase'` means *a camper is moving toward the site and
the player is deciding whether to intercept.* He has a 4.20 m/s sprint with a 1.9 s spin-up
(`GAME_DESIGN.md` §5.1) and in an average playthrough he uses it **twice**, and it is horrifying
both times, because he does not run *at* people. He runs to get somewhere before them. He is
cutting them off. He has read ahead.

---

## 7. THE CAMPERS

Six people who arrived a week early to open a summer camp, which is a genuinely nice thing to
volunteer for. **None of them are stupid. None of them are cruel.** Two of them are in love in a
low-stakes, slightly embarrassing way. All of them are good at their jobs. The player should be
actively annoyed when the game requires them to be hurt.

`AUDIO_DIRECTION.md` §7.4's global direction stands and is the most important note in the VO
brief: **they are not in a horror movie and must never sound like they are. No screaming until
Night Six. The horror is that they are relaxed.**

### 7.1 Character ↔ voice-profile mapping (resolves collision C4)

`AUDIO_DIRECTION.md` §7.4 currently names six people who do not exist in the fiction. The profile
*slots* and their parameter columns are the Audio agent's; the *people* are this document's. This
table is the join, and it is what `tools/generate-voices.mjs` should be keyed on.

| Slot | Was | **Is** | Voice direction | stability | sim | style | boost |
|---|---|---|---|---|---|---|---|
| 1 | DENISE, 22 | **BEVERLY "BEV" RANCZAK, 58** | Female, low alto, dry, unhurried, institutionally calm. Speaks in fragments with the articles removed. Thirty years of Winstons but no rasp performance | 0.62 | 0.82 | 0.18 | true |
| 2 | RANDY, 19 | **COOPER "COOP" VANCE, 20** | Male, bright tenor, fast, laughs at his own jokes and then apologises for them | 0.34 | 0.72 | 0.55 | true |
| 3 | TAMMY, 18 | **MARGUERITE "MARG" TOTH, 21** | Female, dry, low energy, deadpan, narrates her own logistics because it is how she thinks | 0.55 | 0.78 | 0.30 | true |
| 4 | KEVIN "SPUD", 17 | **TEDDY NAKAGAWA, 16** | Male, unsettled register, cracks upward under stress, over-polite | 0.28 | 0.68 | 0.62 | true |
| 5 | MARCIA, 20 | **ROBIN OSEI-HALL, 19** | Female, mid, **precise, not breathy** — she is technical, not sweet. Restarts her own sentences | **0.48** | 0.80 | **0.28** | true |
| 6 | BUD DIETZ, 46 | **DALE PRUITT, 27** | Male, mid-baritone, slow, flat. **Tired, not gravel** — he is twenty-seven, not sixty. Keep the low end un-enhanced | **0.62** | **0.84** | **0.18** | **false** |

**Two profiles change materially and the Audio agent must regenerate them:** slot 5 (Robin is not
warm and breathy; she is exact, and her exactness is her whole character) and slot 6 (Dale is
twenty-seven).

**Per-line overrides.** The table above is the default for every line by that speaker. §8's tables
carry a `Δ` column and it is almost always empty; where it is not, it overrides one field only.
This is deliberately the opposite of v1.0, which restated three voice parameters on every one of
ninety rows and therefore had three sources of truth for the same fact.

### 7.2 The six

**ROBIN OSEI-HALL — 19 — Arts & Crafts.** Second summer. Grew up in her father's boatyard in
Duluth. She has heard ten thousand hours of tools and she knows the difference between a
woodpecker and a mallet the way you know your own name. **That is her tragedy: she is right for a
technical reason nobody else on site can evaluate.**
*Verbal tic:* restarts her own sentences — "Okay so — okay, no, listen." Never finishes the first
attempt.
*Relationship:* older-sister energy toward Teddy; she checks he has eaten.
She is the one who notices on Night Two and is not believed on Night Three. She is the only one who
gets inside the house and understands what it is. **Her expertise is the only thing in the script
that lets a character say something the audience cannot already say** — which is why every line
where she stated the theme instead of a fact has been cut (§8.2).

**DALE PRUITT — 27 — Maintenance.** Sixth summer. Fixes everything, resents nothing, drinks a
little more than he'd like you to know. Calls everyone *chief* or *champ* and trails off mid-thought
with "…anyway." Kind in a way that costs him something. He could corroborate Robin on Night Three
and doesn't, because corroborating means a report, and a report means the county, and the county
means his job.
*Relationship:* Robin's reluctant almost-ally. Their unfinished conversation is the saddest thing
in the bank.
*Dies Night Four, politely, mid-sentence, having knocked first.*

**MARGUERITE "MARG" TOTH — 21 — Waterfront Director.** Third summer. Runs the dock like a small
navy. Counts out loud — "one, two, and — okay" — and narrates her own logistics because it is how
she thinks. Competent, warm, a little bossy, and the one who organises a proper search in pairs on
Night Five instead of a panic. **The forest gets harder because she is good at her job.**
*Relationship:* with Coop, three months, hasn't told her mother.

**COOPER "COOP" VANCE — 20 — Sports & Rec.** Second summer. Loud, plays four chords badly, turns
everything into a bit and then apologises for the bit thirty seconds later. **Write him kind.** His
bits are how he checks whether people are okay. On Night Six he stops doing bits and it is
genuinely alarming.
*Relationship:* Marg; and he has appointed himself Teddy's guy.

**TEDDY NAKAGAWA — 16 — Counselor-in-Training.** First summer away from home. Says *sorry* as
punctuation. Asks permission to do things he has already been told to do. Homesick in the specific
sixteen-year-old way where you would rather die than mention it, and he mentions it exactly once,
to Robin, at 2 a.m., and then changes the subject.
*Relationship:* orbits Coop; is looked after by Robin.

**BEVERLY "BEV" RANCZAK — 58 — Camp Director.** **Here since 1971 — thirteen summers.** Chain-smokes
Winstons. Speaks in fragments with the articles removed: "Get the tarps. Both of 'em. Now." Loves
this place with a fierceness she would never say out loud, and is currently annoyed about a land
survey because it means paperwork.
*Relationship:* everyone's boss; Dale's oldest friend on site.
**She is the living link.** She bought into a camp that came with a burned foundation and a story
she never asked about. She inherited the land's twenty-two years and has been here for thirteen of
them, and the nine-year gap is exactly the size of the thing nobody has looked at.

---

## 8. AMBIENT VO SCRIPT

### 8.1 Rules

Heard at distance, in 3D, through trees, through rain, usually half-caught. **Never a narrator.
Never plot-critical — every line is deniable.** Most under twelve words. `VoiceBank` applies the
full distance chain in `AUDIO_DIRECTION.md` §7.2; the target ratio is **4:1 half-heard to clear**
and there are **at most three fully intelligible lines per night** (§7.1 there).

**Write for the words that survive the filter.** At `I ∈ (0.30, 0.62]` the player gets cadence,
gender, emotion and maybe one word. Every line below is built so that the word most likely to
survive is the one that matters — "mortise," "four," "signed," "hinges," "name."

**The game must be fully playable, and fully sad, with the VO folder deleted.** Voice is weather.

**Projection (`Proj`) — resolves collision C5.** `AUDIO_DIRECTION.md` §7.2's `voLP` curve is tuned
for conversation and makes anything past ~50 m an unrecoverable 200 Hz mush. Half this bank is
people calling to each other across 80–160 m. Every line therefore carries a projection, and
`VoiceBank` applies the constants in §14.4:

| Code | Projection | `voLP` multiplier `k` | `preGain` |
|---|---|---|---|
| **S** | spoken | 1.0 | 0 dB |
| **C** | called (raised, unhurried) | 2.6 | +7 dB |
| **G** | sung / hollered to nobody | 3.1 | +8 dB |
| **H** | shouted (fear, or across water) | 4.0 | +11 dB |

At 118 m an **H** line resolves to a 474 Hz lowpass at +11 dB — a human shape with no words, which
is exactly the intended experience and is currently unreachable.

### 8.2 The six lines that were cut, and why

v1.0 contained six lines that explained the theme to the audience — the exact wink the brief
forbids. They are recorded here so they are not helpfully restored.

| Cut | Was | Now | Reason |
|---|---|---|---|
| `ROB_FEAR_02` | "He looks at you sideways. **Like a bird.**" | **"He looks at you sideways."** | §2.2 already says the bird comparison is what makes nobody believe her. Having Robin supply the simile does the audience's work and kills the line. **She stops at "sideways."** |
| `ROB_FEAR_03` | "It's not a shack. It's a *house*." | **deleted, not replaced** | The thesis, stated aloud, in direct violation of §1.1's own rule. The player has been building the house for six nights. They know what it is |
| `ROB_EVID_03` | "Somebody's *building* something out there." | **"That's a mortise. Somebody cut a *mortise*."** | Technical and worse. Her expertise is her character and it is the only thing that lets her say something the audience cannot |
| `ROB_LATE_03` | "Oh. Oh, you poor —" | **"There's no nails in this. There's no *nails* in it."** (now `ROB_LATE_04`) | The original cued pity on command. The replacement is a fact only a boatyard kid would notice, and it means every joint in the building was cut by hand by one person |
| `MRG_FEAR_01` | "I counted five. There were five of us." | **"Nobody signed out. The board's clean."** | The stock headcount beat. The replacement is Marg being *competent* — the camp has a sign-out board, it is untouched, therefore whoever is gone did not leave |
| `BEV_LATE_04` | "His name was Ansel V—" | **"His name was—"** | v1.0 claimed nobody says his name and then said two-thirds of it fifteen lines later. Now the only identification in the game is "he looks at you sideways," and the name arrives once, wordless, on the last card |

Bev's "Twenty-two summers" / "Twenty-two years" are corrected to **thirteen** throughout (§6, Night
Six).

### 8.3 Legality matrix and repetition budget

v1.0 gated two of ten tables and had a bank of 90 lines carrying six characters across seven nights
of a stealth game in which audio position is the primary threat signal. Pitch-shifting a raccoon
line by 3% on its fortieth play does not make it new; it makes the player aware of the bank.

**Legality — which categories may play on which nights.** `VoiceBank` must refuse anything outside
this grid.

| Category | § | Lines | N1 | N2 | N3 | N4 | N5 | N6 | N7 |
|---|---|---|---|---|---|---|---|---|---|
| Idle chatter | 8.4 | 30 | ● | ● | ● | ● | ● | — | — |
| Work & logistics | 8.5 | 16 | ● | ● | ● | ● | — | — | — |
| Calling across distance | 8.6 | 20 | ● | ● | ● | ● | ● | ● | ● |
| Campfire | 8.7 | 12 | ● | ● | ● | — | — | — | — |
| Arguments | 8.8 | 12 | — | ● | ● | ● | — | — | — |
| "I heard something" | 8.9 | 18 | — | ● | ● | ● | ● | ● | — |
| False alarms | 8.10 | 10 | — | ● | ● | ● | ● | — | — |
| Searching | 8.11 | 24 | — | — | — | ● | ● | ● | ● |
| Finding evidence | 8.12 | 14 | — | — | — | ● | ● | ● | ● |
| Genuine fear | 8.13 | 16 | — | — | — | — | ● | ● | ● |
| Very late | 8.14 | 14 | — | — | — | — | — | ● | ● |
| `CHATTER_BED` (non-lexical) | — | 36 takes | ● | ● | ● | ● | ● | ● | ● |

Dale's lines are legal N1–N4 only. All other speakers are legal on every night they are present.

**Repetition budget** (extends `AUDIO_DIRECTION.md` §7.3, which already forbids a line playing
twice in a night and forbids a second clear play ever):

| Rule | Value |
|---|---|
| Max plays of one line **per night** | **1** (already in `AUDIO_DIRECTION.md` §7.3) |
| Max plays of one line **per playthrough** | **2** |
| Minimum interval between the two plays | **22 minutes of clock time** |
| Second play must be at | `I ≤ 0.62` — half-heard or worse, always |
| Max **scripted** lines per night | **34** |
| Max per category per night | `ceil(nightMinutes / 2.5)` → N1: 4, N4: 6, N7: 9 |
| Bank sufficiency test | any category legal on ≥ 3 nights must hold **≥ 2.2 ×** its per-night cap |

Everything under the cap is `CHATTER_BED` — six non-lexical takes per voice, 4–9 s, delivered as
real sentences and then processed until unrecoverable (`AUDIO_DIRECTION.md` §7.3). **The bed is the
workhorse. Scripted lines are the spice.** At 34 scripted lines across a 19-minute Night Six, a
camper says something specific roughly once every 33 seconds of contact, and the rest of the time
they are just people, audibly, in a wood.

**Total scripted bank: 186 lines**, against v1.0's 90.

### 8.4 Idle chatter — banal, overlapping, funny by accident (N1–5)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `MRG_IDLE_01` | Marg | "One, two — and that's the last of the tarps." | counting to herself | S | |
| `MRG_IDLE_02` | Marg | "Whoever loaded this truck hates me personally." | half-laugh at the end | S | |
| `MRG_IDLE_03` | Marg | "Six life jackets. There should be nine." | mild, logging it | S | |
| `MRG_IDLE_04` | Marg | "I'm not doing the raft again. I did the raft." | flat | S | |
| `MRG_IDLE_05` | Marg | "That's not level. That's nowhere near level." | unbothered | S | |
| `COO_IDLE_01` | Coop | "I'm just saying, powdered eggs are a *choice*." | mid-bit, no punchline | S | |
| `COO_IDLE_02` | Coop | "Sorry, that was — yeah. Sorry." | apologising to nobody | S | |
| `COO_IDLE_03` | Coop | "Does this look level to you? Don't lie." | genuinely asking | S | |
| `COO_IDLE_04` | Coop | "Four chords, Marg. Four. It's a whole song." | delighted with himself | S | |
| `COO_IDLE_05` | Coop | "Okay but who *decided* the archery range goes there." | idle, real question | S | |
| `COO_IDLE_06` | Coop | *tuneless humming, 6 s, trails off* | to himself | G | |
| `DAL_IDLE_01` | Dale | "Third year that pump's gone out. Anyway." | trails off, no ending | S | |
| `DAL_IDLE_02` | Dale | "You want it done, or done right. Champ." | old joke, said flat | S | |
| `DAL_IDLE_03` | Dale | "Ah — nope. That's a hornet situation." | retreating, unbothered | S | |
| `DAL_IDLE_04` | Dale | "Ground's soft down there. Always has been." | to nobody | S | |
| `DAL_IDLE_05` | Dale | "Somebody's been in my ladder. Anyway." | not suspicious, mildly put out | S | |
| `DAL_IDLE_06` | Dale | *two bars of a song, gives up, starts again, gives up* | drunk, cheerful | G | |
| `ROB_IDLE_01` | Robin | "Okay so — okay, no. Start over." | correcting herself | S | |
| `ROB_IDLE_02` | Robin | "Teddy. Teddy. Did you eat? Don't lie to me." | sisterly, insistent | C | |
| `ROB_IDLE_03` | Robin | "My dad would've had this done in an hour." | fond, a little proud | S | |
| `ROB_IDLE_04` | Robin | "These brushes are older than me. Genuinely." | amused | S | |
| `ROB_IDLE_05` | Robin | "It's warped. It's — you can see it's warped." | to someone not listening | S | |
| `TED_IDLE_01` | Teddy | "Sorry — is this the right shed? Sorry." | over-polite | S | |
| `TED_IDLE_02` | Teddy | "My mom packed like nine cans of soup." | small laugh at himself | S | |
| `TED_IDLE_03` | Teddy | "Am I allowed to just — do that? Or." | asking permission again | S | |
| `TED_IDLE_04` | Teddy | "There's a *loon*. That's a loon, right?" | genuinely delighted | S | |
| `BEV_IDLE_01` | Bev | "Rain by Thursday. Get the canvas up." | no articles, no warmth | C | |
| `BEV_IDLE_02` | Bev | "Thirteen summers. Never once on schedule." | almost affectionate | S | |
| `BEV_IDLE_03` | Bev | "Coffee's in the hall. Don't make more." | absolute | C | |
| `BEV_IDLE_04` | Bev | "Company sold the lease. So now there's a survey." | disgusted, about paperwork | S | |

### 8.5 Work & logistics — people being good at their jobs (N1–4)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `MRG_WORK_01` | Marg | "Docks first, then the rack, then we eat." | organising | C | |
| `MRG_WORK_02` | Marg | "Two on that end. Two. Not one. Two." | patient, repeating | C | |
| `MRG_WORK_03` | Marg | "Tide's nothing, it's a lake, just — hold it." | exasperated, fond | S | |
| `MRG_WORK_04` | Marg | "One, two, and — okay. Okay, down." | counting a lift | S | |
| `DAL_WORK_01` | Dale | "Breaker's out. Give me ten. Anyway." | walking away | C | |
| `DAL_WORK_02` | Dale | "That joist is done. That whole run's done." | professional judgement | S | |
| `DAL_WORK_03` | Dale | "I'll shim it. It'll hold till August." | resigned | S | |
| `DAL_WORK_04` | Dale | "Don't drive on the grass. Bev'll skin us." | mild | C | |
| `ROB_WORK_01` | Robin | "Grain's going the wrong way. See that? See?" | teaching, delighted | S | |
| `ROB_WORK_02` | Robin | "It's not glued, it's *pegged*. Somebody pegged it." | admiring | S | |
| `ROB_WORK_03` | Robin | "Hand me the — no, the other — thank you." | absorbed | S | |
| `COO_WORK_01` | Coop | "I have got this. I have absolutely got this." | does not have this | C | |
| `COO_WORK_02` | Coop | "Okay that's heavier than it looks. That's heavy." | laughing, straining | S | |
| `TED_WORK_01` | Teddy | "Where does this go? Sorry — where does this go." | anxious | S | |
| `TED_WORK_02` | Teddy | "I can carry more than that. I can, honestly." | wanting to be useful | S | |
| `BEV_WORK_01` | Bev | "Buses at nine on Saturday. Nine. Move." | flat, absolute | C | |

### 8.6 Calling across distance — the loudest lines in the game (N1–7)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `MRG_CALL_01` | Marg | "Coop! Other end! Other *other* end!" | shouted, laughing | H | |
| `MRG_CALL_02` | Marg | "Say again? You're breaking up in the trees!" | cupped hands | H | |
| `MRG_CALL_03` | Marg | "Two minutes! I said two minutes!" | mock-furious | H | |
| `MRG_CALL_04` | Marg | "Robin! You seen Dale?" | ordinary, N4+ | H | |
| `COO_CALL_01` | Coop | "Yeah — hang on — yeah!" | half-shouted, muffled | H | |
| `COO_CALL_02` | Coop | "I'm coming! I'm literally coming!" | laughing | H | |
| `COO_CALL_03` | Coop | "Teddy! Ted! Stay where I can see you!" | N5+, no bit in it | H | |
| `ROB_CALL_01` | Robin | "Dale? You up by the shed?" | carrying, unworried | C | |
| `ROB_CALL_02` | Robin | "Nothing! Never mind!" | giving up on being heard | H | |
| `ROB_CALL_03` | Robin | "Turn it *off* a second! Just — off!" | urgent, N3+ | H | |
| `ROB_CALL_04` | Robin | "Marg! Come look at this! Marg!" | N4+ | H | |
| `DAL_CALL_01` | Dale | "Yeah, chief, I'm here!" | from far off | H | |
| `DAL_CALL_02` | Dale | "Give me a minute! I'm up a ladder!" | cheerful | H | |
| `BEV_CALL_01` | Bev | "Everybody. Mess hall. Ten minutes." | flat, absolute | C | |
| `BEV_CALL_02` | Bev | "Torches. Everyone gets a torch. Now." | N4+ | C | |
| `BEV_CALL_03` | Bev | "Nobody past the fire road. Nobody." | N5+ | H | |
| `TED_CALL_01` | Teddy | "Coop? Was that you?" | too quiet to carry | C | |
| `TED_CALL_02` | Teddy | "Is anyone — hello? Sorry — hello?" | N5+, thin | C | |
| `MRG_CALL_05` | Marg | "Sound off! Everybody sound off!" | N6+, command voice | H | |
| `COO_CALL_04` | Coop | "Dale! DALE!" | N5+, no joke left | H | `style +0.10` |

### 8.7 Campfire — Nights 1–3 only

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `COO_FIRE_01` | Coop | "…and *that's* why we don't swim past the raft." | doing a voice, badly | S | |
| `MRG_FIRE_01` | Marg | "That's not true. None of that is true." | interrupting | S | |
| `COO_FIRE_02` | Coop | "It's *emotionally* true, Marguerite." | mock-wounded | S | |
| `DAL_FIRE_01` | Dale | "There was a house out on the point. Before." | throwaway, no weight | S | |
| `MRG_FIRE_02` | Marg | "Before what?" | genuine, small | S | |
| `DAL_FIRE_02` | Dale | "Before the camp. Burned, I think. Anyway." | he does not care yet | S | |
| `TED_FIRE_01` | Teddy | "Is it okay if I sit here? Sorry." | barely audible | S | |
| `ROB_FIRE_01` | Robin | "Sit down, Teddy. God." | laughing at him kindly | S | |
| `BEV_FIRE_01` | Bev | "Fire's out by eleven. I mean out." | not unkind | S | |
| `COO_FIRE_03` | Coop | "Bev. Bev. Tell the one about the bear." | wheedling | S | |
| `BEV_FIRE_02` | Bev | "No." | complete sentence | S | |
| `ROB_FIRE_02` | Robin | "My dad says a good dock outlives the man." | quiet, fond, N3 | S | |

### 8.8 Arguments — small, domestic, real (N2–4)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `MRG_ARG_01` | Marg | "I *asked* you to do it before dark." | tired, not angry | S | |
| `COO_ARG_01` | Coop | "And I said I would, and I'm doing it." | flat, hurt | S | |
| `MRG_ARG_02` | Marg | "You do the bit instead of the thing." | true, and it lands | S | |
| `COO_ARG_02` | Coop | "…Yeah. Okay. Yeah." | no bit available | S | |
| `BEV_ARG_01` | Bev | "Not tonight. Both of you." | zero volume, total authority | S | |
| `BEV_ARG_02` | Bev | "Sound carries over the water. Happens every year." | **kind, and wrong** | S | |
| `BEV_ARG_03` | Bev | "It's a generator. It's always a generator." | patient, reasonable | S | |
| `ROB_ARG_01` | Robin | "It wasn't the water. It was — okay. Fine." | giving up mid-sentence | S | |
| `ROB_ARG_02` | Robin | "So that's a no. That's a no, Dale." | very controlled | S | |
| `DAL_ARG_01` | Dale | "If we call it in, it's a report. Anyway." | won't meet her eye | S | |
| `DAL_ARG_02` | Dale | "I need this job past August. That's all." | ashamed | S | |
| `TED_ARG_01` | Teddy | "Are you guys — sorry. Never mind." | backing out of a room | S | |

### 8.9 "I heard something" (N2–6)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `ROB_HEAR_01` | Robin | "Shh — shh. There. That." | dead still, whispered | S | |
| `ROB_HEAR_02` | Robin | "That's a mallet. That's somebody driving a stake." | technical, unsettling | S | |
| `ROB_HEAR_03` | Robin | "Four hits. Even. Nothing hits four times even." | building an argument | S | |
| `ROB_HEAR_04` | Robin | "That's a *hand* saw. That's not a chainsaw." | N3, certain | S | |
| `ROB_HEAR_05` | Robin | "It stops when we stop. Listen. Listen." | N4+ | S | |
| `MRG_HEAR_01` | Marg | "Okay, I heard that one. I heard that." | conceding, not scared | S | |
| `MRG_HEAR_02` | Marg | "It stopped. Why did it stop." | not a question | S | |
| `MRG_HEAR_03` | Marg | "That's not the campground. That's close." | N4+ | S | |
| `COO_HEAR_01` | Coop | "Deer. That's deer. That's a deer thing." | reassuring himself | S | |
| `COO_HEAR_02` | Coop | "Okay that's — okay, that's not funny now." | bit collapsing in real time | S | |
| `COO_HEAR_03` | Coop | "Do deer hammer? Is that a thing deer do?" | trying, failing | S | |
| `DAL_HEAR_01` | Dale | "Huh." | one syllable, thoughtful | S | |
| `DAL_HEAR_02` | Dale | "That's somebody working. That's work." | recognising it, N3 | S | |
| `TED_HEAR_01` | Teddy | "Something moved. Over — there. Sorry." | pointing, small voice | S | |
| `TED_HEAR_02` | Teddy | "It was going the same speed as us." | N5+, quiet | S | |
| `BEV_HEAR_01` | Bev | "Quiet. Everybody. Quiet." | drops to nothing | S | |
| `BEV_HEAR_02` | Bev | "That's a hammer. That's a claw hammer." | N5+, recognising work | S | |
| `BEV_HEAR_03` | Bev | "Somebody's out past the point." | flat, N6 | S | |

### 8.10 False alarms — the comedy that stops being comedy (N2–5)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `COO_FALSE_01` | Coop | "AH — okay. Okay. Raccoon. It's a raccoon." | genuine fright, fast recovery | S | |
| `MRG_FALSE_01` | Marg | "You screamed. You actually screamed." | relieved laughing | S | |
| `TED_FALSE_01` | Teddy | "Sorry! Sorry, that was me, sorry." | mortified | S | |
| `ROB_FALSE_01` | Robin | "It's fine. It's fine. Everyone breathe." | doesn't believe it | S | |
| `COO_FALSE_02` | Coop | "See? Nothing. Told you. Nothing." | the bit isn't working | S | |
| `DAL_FALSE_01` | Dale | "Little guy's got more right to be here than us." | fond, about the raccoon | S | |
| `MRG_FALSE_02` | Marg | "That's my *own torch*. That's my own torch." | laughing at herself, N4 | S | |
| `TED_FALSE_02` | Teddy | "I thought it was — it was a coat. It's a coat." | shaky, N5 | S | |
| `COO_FALSE_03` | Coop | "Ha. Ha ha. Okay. Yep." | N5, nothing behind it | S | |
| `ROB_FALSE_02` | Robin | "Don't do that. Don't *do* that." | not laughing, N5 | S | |

### 8.11 Searching (N4–7)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `MRG_SRCH_01` | Marg | "Pairs. Nobody goes out alone, I mean it." | commanding, steady | C | |
| `MRG_SRCH_02` | Marg | "One, two — Robin, that's three, where's Coop?" | rising | C | |
| `MRG_SRCH_03` | Marg | "We've been past that stump twice." | quiet realisation | S | |
| `MRG_SRCH_04` | Marg | "Grid it. North to south. Like the swim test." | competent under pressure | C | |
| `MRG_SRCH_05` | Marg | "Call back if you can hear me. Anyone." | N6+ | H | |
| `COO_SRCH_01` | Coop | "Dale? Buddy? You messing with us?" | wants to be pranked | H | |
| `COO_SRCH_02` | Coop | "Dale! Come on, man!" | shouting into trees | H | |
| `COO_SRCH_03` | Coop | "He's at the truck. He's gonna be at the truck." | to himself | S | |
| `COO_SRCH_04` | Coop | "I checked the truck." | very small | S | |
| `ROB_SRCH_01` | Robin | "Check the boathouse. The door's *gone*." | flat, professional, N4 | C | |
| `ROB_SRCH_02` | Robin | "Stop. Everybody stop. Listen." | commanding for the first time | C | |
| `ROB_SRCH_03` | Robin | "Follow the sawdust. It goes somewhere." | N5+ | S | |
| `ROB_SRCH_04` | Robin | "There's a path. It's not a deer path." | N5+ | S | |
| `BEV_SRCH_01` | Bev | "Torches low. Watch the roots." | still doing her job | C | |
| `BEV_SRCH_02` | Bev | "Back to the road. Now. Move." | no fear in it, only speed | H | |
| `BEV_SRCH_03` | Bev | "Two hours. County said four. It's been two." | N6 | S | |
| `BEV_SRCH_04` | Bev | "Kids in the hall. Doors shut. Go." | N6+ | C | |
| `TED_SRCH_01` | Teddy | "How far do we go? Sorry — how far?" | asking permission again | S | |
| `TED_SRCH_02` | Teddy | "I'll go with you. I'd rather go with you." | N5+ | S | |
| `TED_SRCH_03` | Teddy | "Can we stop? Can we just — can we stop." | N6+ | S | |
| `MRG_SRCH_06` | Marg | "Nobody signed out. I checked twice." | N5+ | S | |
| `COO_SRCH_05` | Coop | "What do we even do. What do we *do*." | N6+, no bit | S | |
| `ROB_SRCH_05` | Robin | "I'm going up to the point." | N6, decided, quiet | S | |
| `BEV_SRCH_05` | Bev | "You are not. Robin. You are not." | N6, and she goes anyway | C | |

### 8.12 Finding evidence (N4–7)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `ROB_EVID_01` | Robin | "This is sawdust. In June. From what?" | crouched, close | S | |
| `ROB_EVID_02` | Robin | "There's a path here. Somebody's worn a path." | the moment it becomes real | S | |
| `ROB_EVID_03` | Robin | **"That's a mortise. Somebody cut a *mortise*."** | technical, appalled | S | |
| `ROB_EVID_04` | Robin | "The cut's clean. Whoever did this is *good*." | and that is the frightening part | S | |
| `MRG_EVID_01` | Marg | "The door's gone. The whole *door*." | baffled, N4 | S | |
| `MRG_EVID_02` | Marg | "Now the hinges. They came back for the hinges." | N6, and it lands | S | |
| `MRG_EVID_03` | Marg | "Don't touch it. Don't — Teddy, don't touch it." | protective | C | |
| `COO_EVID_01` | Coop | "Who takes a door. Who *takes a door*." | trying to make it funny | S | |
| `COO_EVID_02` | Coop | "There's a *ladder* up there. That's our ladder." | N5 | S | |
| `BEV_EVID_01` | Bev | "That's not camp lumber. That's milled." | recognising work | S | |
| `BEV_EVID_02` | Bev | "Somebody's been out here months." | N6, quiet | S | |
| `TED_EVID_01` | Teddy | "It's Dale's. That's Dale's torch. That's his." | voice going thin | S | |
| `TED_EVID_02` | Teddy | "It's stood up. Someone stood it up." | N5, and nobody answers | S | |
| `DAL_EVID_04` | Dale | "…the hell is this, chief." | to nobody, N4, unafraid | S | |

### 8.13 Genuine fear (N5–7)

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `TED_FEAR_01` | Teddy | "I want to go home. I'm sorry. I want to go home." | whispered, no performance | S | |
| `TED_FEAR_02` | Teddy | "Is he still there? Is he still—" | cut off by his own breath | S | |
| `TED_FEAR_03` | Teddy | "I'm not sorry. I'm not — I'm not saying sorry." | breaking, N7 | S | |
| `ROB_FEAR_01` | Robin | "Okay. Okay. Okay okay okay." | self-soothing, fast | S | |
| `ROB_FEAR_02` | Robin | **"He looks at you sideways."** | trying to describe it, and stopping | S | |
| `ROB_FEAR_03` | Robin | "He wasn't running. Why wasn't he running." | N6+ | S | |
| `COO_FEAR_01` | Coop | "Marg. Marg, look at me. Look at me." | trying to hold her together | S | |
| `COO_FEAR_02` | Coop | "I'm not — I can't do a joke. I don't have one." | genuinely undone | S | |
| `COO_FEAR_03` | Coop | "I keep waiting for it to be a bit." | N7, flat | S | |
| `MRG_FEAR_01` | Marg | **"Nobody signed out. The board's clean."** | numb, and it is worse than a headcount | S | |
| `MRG_FEAR_02` | Marg | "Run to the road. Don't stop at the truck." | commander to the last | H | |
| `MRG_FEAR_03` | Marg | "I'm counting. I'm going to keep counting." | N7 | S | |
| `BEV_FEAR_01` | Bev | **"Thirteen years. Never. Not once."** | first crack in her | S | |
| `BEV_FEAR_02` | Bev | "This is my camp. This is *my* camp." | N7, and it isn't | S | |
| `ROB_FEAR_04` | Robin | "He was *measuring*. He had a — he was measuring." | N6+, cannot make it sound sane | S | |
| `TED_FEAR_04` | Teddy | "The buses come at nine. Nine o'clock." | dazed, repeating | S | |

### 8.14 Very late — Nights 6 and 7 only

| ID | Speaker | Line | Delivery | Proj | Δ |
|---|---|---|---|---|---|
| `BEV_LATE_01` | Bev | "County's four hours out. Four hours." | reporting a fact | S | |
| `BEV_LATE_02` | Bev | "There was a family on this shore. Before us." | dawning | S | |
| `BEV_LATE_03` | Bev | "Boy was big. Quiet. Fixed the dock for nothing." | remembering a kindness | S | |
| `BEV_LATE_04` | Bev | **"His name was—"** | stops herself dead | S | |
| `BEV_LATE_05` | Bev | "I never asked. Thirteen years. Never asked." | N7 | S | |
| `BEV_LATE_06` | Bev | "It's still standing. That dock. It's still standing." | N7, and she doesn't know why she said it | S | |
| `ROB_LATE_01` | Robin | "There's marks on the door. Pencil. Somebody's kid." | inside the house, whispering | S | |
| `ROB_LATE_02` | Robin | "Fifty-three. Fifty-five. Fifty-seven." | reading four numbers she thinks are measurements | S | |
| `ROB_LATE_03` | Robin | "This one's over my head. This one's — " | hand flat on the top mark | S | |
| `ROB_LATE_04` | Robin | **"There's no nails in this. There's no *nails* in it."** | appalled, admiring, both | S | |
| `ROB_LATE_05` | Robin | "There's two chairs." | N7, from the treeline, to nobody | S | |
| `TED_LATE_01` | Teddy | "The buses come at nine. They're gonna come at nine." | shock, repeating | S | |
| `COO_LATE_01` | Coop | "Is that a *window*? That's got a window in it." | N7, and it destroys him | S | |
| `MRG_LATE_01` | Marg | "Whoever built that isn't finished." | N7, flat, correct | S | |

**Bank total: 186 scripted lines + 36 `CHATTER_BED` takes.** Cut lines are listed in §8.2 and must
not be regenerated.

---

## 9. ENVIRONMENTAL STORYTELLING — 22 OBJECTS

Placed by `Props.js` or `CabinSite.js`. All are **inert** — no pickup prompt, no lore entry, no
audio sting — except props 1, 3, 10, 16 and 22, which are parts or tools and are handled by
`BuildSystem`. If a player never notices one, that is fine. That is the point.

**What changed.** v1.0's twenty objects stated one fact eleven times: *his boot, his swing, his
mother's grave, his mask, his house, his drawing, his survey, his photo, his notches, his blanket.*
That is not environmental storytelling — environmental storytelling runs on **gap and
contradiction**, and everything there resolved to the same answer. Meanwhile the twenty-two years
between the fire and the game, the thing nobody in the fiction has thought about, was a blank.

Four "his" props are cut outright: the tool roll spread under an oilcloth (he wears it), the
carpenter's pencil as scenery (it is a tool now, §10.3), the floor plan carved into a rock face
(the twelfth statement of the same fact), and the rusted swing seat in the archery range (the
thirteenth). Two clichés are replaced in place (props 4 and 21). **Five new objects carry
1962–1984**, and the best of them is walked on every single night.

**Kept against the note:** the tin of ruined pages (prop 6). It is the only object in the game that
shows him *failing*, and everything else shows him succeeding. It earns its slot on contradiction.

### 9.1 His — nine objects

| # | Object | Where | Reads as | On replay |
|---|---|---|---|---|
| 1 | **The 1961 Minnesota licence plate**, folded in three | Under the fallen log, 31.6 m NW | Somebody levelled something out here once | It was under the original house. He kept it. It has always been the shim |
| 2 | **A ring of foundation stones**, black at the edges | The build site — **visible from Night One, in every light**, with the tutorial's chalk squares drawn onto them | A fire | Every pier lands on an old one. He is building exactly on the footprint. On Night Six they are the only true reference in the world (§6, N6) |
| 3 | **A porcelain sink**, cracked, a rectangular section missing from its splash-back | Propped against a birch, 60.0 m WNW | Camp junk | That rectangle is on his face — and on Night Six the player carries it back and installs it (§10.1) |
| 4 | **A child's boot, size 3, on a shelf** | The lean-to, 77.2 m WNW | Somebody built a shelf out here | The shelf is hand-cut, mortised, and level. **There is a second shelf beside it and it is empty.** *(v1.0 hung the boot on a nail at head height — haunted-woods boilerplate, and it contradicts the character: hanging a totem is a raving gesture and §2 insists he never raves. He built it somewhere sensible.)* |
| 5 | **Fifty-one wooden survey stakes**, carpenter's pencil, driven in a perfect grid | Across the site | Planning | The numbering starts at **1953**. They are years, not stake numbers, and there are fifty-one of them |
| 6 | **A tin of ruined manual pages**, weighted under a rock, dry | 24 m W of the site | Somebody's rubbish | Twelve attempts at the same panel, each worse than the last. He has been trying to draw his mother's hand, and failing, since long before Night One |
| 7 | **Four notches on a birch trunk** at 91, 108, 124 and 141 cm | 15.0 m SSW — the tree that stood outside the kitchen door | Somebody measured something | They match the doorframe marks the player makes on Night Six **exactly**, and they predate the house by thirty-one years |
| 8 | **A wide flat stump, a folded blanket, a tin cup** | 11.4 m SE | A place to sit | The player has been sitting there every night since Night One (§13.2). **The second seat, the one with the blanket on it, cannot be sat in.** The game refuses it silently for six nights |
| 9 | **Two chairs**, hand-made, identical joinery, different sizes | Inside the house, Night Seven | Furniture | — |

### 9.2 1984 — the county — two objects

| # | Object | Where | Reads as |
|---|---|---|---|
| 10 | **Ten steel survey stakes with orange plastic ribbon**, driven April 1984 | Across the point; four inside the kitchen footprint; one in the doorway | The most recent thing that has happened here. The player pulls the first one in the game's first ninety seconds (§1.4) |
| 11 | **The brass survey marker**, 1962, stamped `WANAKA PINES LAND CO.` | 21.9 m SE, at the property line | Polished bright by something rubbing it. He cleans it. Every night. It is the only piece of the Land Company he has ever been able to maintain |

### 9.3 1962–1984 — the middle — five objects

| # | Object | Where | Reads as | The gap |
|---|---|---|---|---|
| 12 | **The dock** | 49.6 m NNW | The dock | He fixed it in 1962 for nothing and it is still the best-built structure at this camp. **It is the only wooden structure in the game that never creaks** — `state.installed` treats its boards as `correct: true, torque: 1.0` permanently. In a game where creak means wrongness, one thing in the world is silent, and the player walks over it every night, and by about Night Four they notice. If the Ranger arrives (§6.10, rung 5) his truck parks on it |
| 13 | **The camp entrance sign** | 202.2 m SSE, on the county road | A camp sign | It is painted on a panelled door. There is a **mortised lockset hole** in it, plugged with a wooden bung. The camp made its welcome sign out of his front door in 1971 and nobody alive remembers doing it. Robin's `ROB_EVID_03` is about a mortise |
| 14 | **A burn permit**, nailed inside the boathouse | The boathouse | A form. **Unreadable** (§0.6) — a grey blur with a county seal, one legible date stamp — `14 OCT 1962` — and one legible number, `9-114` | Marit is not on it, because she was not a structure |
| 15 | **A 1958 Land Company travel brochure**, in the box | Inside prop 16 | Photographs of a lake, mountains, pines | It is a lake in **Otago, New Zealand**. It is not this lake. This is where the name came from (§4.5) |
| 16 | **A cardboard box of the Vik house's papers**, under the canoe rack, holding it level | The boathouse | A box | The Land Company cleared the house in 1962 and boxed the papers and the box has been shimming a canoe rack for twenty-two years. **The Night Six errata slip — the real step 9, in Marit's hand — is in it**, and to the game and to the manual and to the man it is a red-outlined manifest item |

### 9.4 The camp — four objects

| # | Object | Where | Reads as |
|---|---|---|---|
| 17 | **Bev's ashtray** — a hubcap, forty butts, all crushed the same direction | Camp office porch, 157.9 m ESE | A woman who sits in the same chair every night. **The chair faces bearing 293°, which is the datum**, which is where the house used to be, and she has never once wondered why that is the nice view |
| 18 | **The camp photo board** — thirteen summers of group photos | Mess hall | In the **1971** frame — Bev's first — at the back edge, out of focus, a very large man at the treeline **with his head tilted** (§2.2) |
| 19 | **The boathouse door frame** | 100.5 m ENE | Leaf gone from Night Four. Hinges gone from Night Six. Propped with an oar and never fixed. The camp is losing, one component at a time, and each one is a part number |
| 20 | **Dale's torch, stood upright on a stump, lens-up, still on** | `(+46, −4)`, 46 m E | Because he needed both hands, and there was a stump, and you put a light where it will be useful. A 20 m cone straight up into the rain, browning as the battery dies, **visible from the canoe rack**, and nobody comes. On Night Seven it is off, and it has been moved **8.5 m toward the house**, and set down neatly |

### 9.5 The ground — two objects

| # | Object | Where | Reads as |
|---|---|---|---|
| 21 | **A rectangle of hand-cut grass.** No stone. No mound. No fence. No flowers | 117.0 m WSW, ridge shoulder, +14 m | *(v1.0 had an unmarked, well-kept grave — the most predictable object available in this genre, and it answers the mystery before the manual gets to it.)* This is a patch of grass that is mowed. It is not evidence of anything. **There is nothing to find here and that is what makes it unbearable**: a 2.0 × 0.9 m rectangle where the grass is 40 mm and everywhere else it is 300 mm, and no tool anywhere near it, and no path to it |
| 22 | **A canoe, upside down, full of lake stones**, one gunwale crushed under a truss heel | The build site, from Night Five | Improvisation. It is Dale's canoe. It is holding up the roof |

---

## 10. THE THREE FIRST-PLAYTHROUGH REVELATIONS

v1.0's story was legible only on a second playthrough and the document knew it: eleven of twenty
props carried a *Replay:* tag, props were inert, there was no narrator, no world text, no
collectible and no readable manual. That left exactly one first-playthrough channel for the whole
Marit story — four `BEV_LATE_*` lines heard at distance through rain, and one scene of Robin in a
doorway. A first-time player would finish with "big man built a house, family lived here once, two
chairs," and the thesis would never arrive.

**Three revelations are now unmissable, and each is gated on a mechanic the player must perform to
finish the game.** None of them is a cutscene. None of them takes the camera. All three are on
Night Six.

### 10.1 The sink — *he carries his own face across the site and mounts it*

**Slot `SK-01`. Required to complete Night Six.**

The porcelain sink has been leaning against a birch at 60.0 m WNW since Night One, with a
rectangular section missing from its splash-back. On Night Six the manual asks for it. It is a
class-C carry, 31 kg, 60 m of wet ground, and it takes about 80 seconds.

The sink seats **under a window**, and the glazing goes in first, and the glass is black because it
is 02:00 and there is a forest behind it.

**On the seating of `SK-01`, for 1.4 seconds, the window reflects.**

| Property | Value |
|---|---|
| Surface | The `GL-06` glazing quad only — 0.62 × 0.94 m |
| Technique | One planar reflection, `RenderTarget` 256 × 384, one camera, one frame captured at seat, held | 
| Cost | ~0.4 ms, once, for 1.4 s |
| Camera | **Unmoved.** No cut, no take-over, no zoom, no slow-motion. The player has leaned in because seating a sink requires leaning in |
| What is in it | A mask. Off-white. Curved. A left eye that is a nipped oval and a right eye that is a factory overflow slot, 31 mm too low |
| What is 400 mm in front of it | The rectangular hole in the splash-back |
| **They are the same rectangle** | |

No sting. No line. No prompt. The reflection fades with the seating animation and the game does not
mention it again. Flag `installedSink`.

### 10.2 The ruin anchors — *the validation channel, visible and explained*

Already covered mechanically in §6, Night Six. The point for this section: the stones are the
**second** revelation and they are revealed by *use*, not by looking.

The player has placed every pier, sill, post and truss of this house on top of a burned foundation
since minute two, and has never been told. On Night Six the manual breaks, the fog draws the trench
(§6), and `BuildSystem` starts validating against `CabinSite.ruinAnchors` — and the moment the
player realises the anchors *work*, they realise the anchors have been correct all along, which
means the house they have built is not a copy of the drawing. **It is a copy of the ground.**

`GAME_DESIGN.md` §2.2's `Slot` struct needs no change: the anchors are the slots' authority, and
always were.

### 10.3 The doorframe — *a placement he makes, not scenery she finds*

**Slots `PM-01` … `PM-04`. Required to complete Night Six.**

v1.0 had Robin discover four pencil marks on a doorframe. That is a nice image and it is the wrong
verb: it is scenery, delivered to a character, in a game about a player's hands.

**The player makes the marks.**

After `DF-01` (the doorframe) seats, the manual's next panel is 6.8 (hero): the kitchen wall
elevation in Marit's hand — a window over a sink, and four short horizontal ticks on the left jamb.
Beside them, in the parts bracket: **the carpenter's pencil**, sharpened to 8 mm, which has been on
his hip since Night One and has been replaced with an identical one every night.

Four placements, in the manual's own grammar, against four 40 mm slots on the jamb:

| Slot | Height | The player must |
|---|---|---|
| `PM-01` | **91 cm** | **Crouch.** The lowest interaction in the game |
| `PM-02` | 108 cm | Crouch |
| `PM-03` | 124 cm | Stand |
| `PM-04` | 141 cm | Stand |

Each mark takes 1.6 s and is silent. **The player draws a child's growth on a doorframe, four
times, from a diagram, and has to crouch for the first two.**

And beside each one the manual asks for a numeral, and he copies it, because Marit taught him
numbers even though she never got him past them: `53`, `55`, `57`, and a fourth that is not a year
and is the reason there are only four marks.

**He does not know they are years.** He knows they are part of the drawing.

If `DF-01`'s jamb is out by more than 1.0°, the marks land at the wrong heights, and the manual
redraws them, in his hand, wrong, and he copies them anyway (§6.8).

Flag `markedDoorframe`. It gates `n6_robin_inside`, because the marks are what she finds — and by
then they are ninety minutes old and the player put them there.

They match the birch (prop 7) exactly, and the birch has been standing 15 m from the build site for
seven nights.

### 10.4 The interior — the money shot, budgeted, with an owner (resolves C6)

`ARCHITECTURE.md` §9 gives `CabinSite.js` "the build plot, foundation, slot layout." **Nobody owned
the furnished interior**, which is the last ten minutes of the game and the image the whole thing
is for. `CabinSite.js` owns it. Amend the ownership line to *"the build plot, foundation, slot
layout, and the finished interior."*

**On the Call of Duty parity claim: we drop it for this one room, on purpose, and here is the
reasoning so nobody re-adopts it.** A wet exterior forest at night hides a multitude — silhouette
mass, fog, falloff, rain. A lit room at 03:40 hides nothing, and authored micro-detail, decals and
hand-placed dressing are exactly where a fully procedural, zero-binary-asset pipeline has nowhere
to go. Competing there is a fight we would lose in the one place we cannot afford to lose it.

**So the interior is not detailed. It is *dark*, and it is *shaped*, and it is one light.**

| Budget | Value |
|---|---|
| **Draw calls** | **≤ 34** of the 220 (`ARCHITECTURE.md` §10). Walls are the best occluder in the game — the forest culls almost entirely, so the interior is a net *win* on the frame |
| Breakdown | shell 4 (one call per material) · floorboards 1 (instanced) · glazing 1 (instanced) · furniture 1 (table + both chairs, merged) · sink + flue + doorframe 1 · pencil-mark decal atlas 1 · lantern volumetric 2 · slack **23** |
| **Unique procedural materials in the room: 7** | sawn pine · planed pine · fired porcelain · blackened steel (flue) · glass · cast iron (stove, cold) · graphite (the marks) |
| **Texel density** | **512 px/m** on exactly three hero surfaces — the doorframe jamb, the sink splash-back, the small chair's seat. **170 px/m** everywhere else. `ART_DIRECTION.md`'s `settings.tier(256,512,1024,2048)` hero-surface budget already covers this |
| **Lighting: one practical.** | The player's lantern, set down on the table at 0.72 m. `SpotLight` → `PointLight`, `decay: 2`, `distance: 6.5`, intensity 22, `#ffb865`. **Nothing else in the room emits.** The stove is cold |
| Falloff | At `decay: 2` and intensity 22, luminance at 3.0 m is ≈ 0.004 — below `#0a1216` (`ART_DIRECTION.md` §2). **The far corners of the room are not dark for atmosphere. They are dark because that is what one lamp does** |
| The read | Shapes. A doorway. A rectangle of window. A table edge. Two chair backs, one of them low. Near-silhouette |
| Reference | Single-source Wyeth interior, not a lit set. Andrew Wyeth, *Christina's World*'s house from inside. `ART_DIRECTION.md` §1's reference table should add it |

The one thing in the room rendered at full fidelity is the surface the player's hand is on, and the
lantern is 400 mm from it.

---
