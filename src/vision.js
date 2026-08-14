// Screenshot ingest via Claude vision. Extracts structured data from Club GG /
// PokerStars lobby screenshots. Human-in-the-loop: results pre-fill the admin
// editors for review — nothing is committed here. Roster handles are matched by
// Claude but low-confidence matches are flagged, never auto-assigned.
import Anthropic from "@anthropic-ai/sdk";

let client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error("Screenshot reading isn't set up: add ANTHROPIC_API_KEY to the server's .env.");
    e.statusCode = 503;
    throw e;
  }
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}
const MODEL = process.env.VISION_MODEL || "claude-opus-5";

const nullable = (t) => ({ anyOf: [t, { type: "null" }] });
const CONF = { type: "string", enum: ["high", "medium", "low"] };

async function extract(image_base64, media_type, prompt, schema) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type, data: image_base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

function rosterText(players) {
  return players
    .map((p) => `id=${p.id} name="${p.name}" handles=[${(p.handles || []).join(", ")}]`)
    .join("\n");
}

// 1) Tournament setup from a lobby detail screenshot.
export function extractSetup(image_base64, media_type) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["game_type", "tournament_type", "reentry_allowed", "buyin_dollars", "start_datetime", "late_reg_minutes", "title", "notes"],
    properties: {
      game_type: nullable({ type: "string" }),
      tournament_type: { type: "string", enum: ["Regular", "Satellite", "Freeroll", "Bounty", "Mixed Game", "Other"] },
      reentry_allowed: { type: "boolean" },
      buyin_dollars: nullable({ type: "number" }),
      start_datetime: nullable({ type: "string" }),
      late_reg_minutes: nullable({ type: "integer" }),
      title: nullable({ type: "string" }),
      notes: nullable({ type: "string" }),
    },
  };
  const today = new Date().toISOString().slice(0, 10);
  const prompt = [
    "This is a screenshot of an online poker tournament lobby (Club GG / PokerStars style).",
    `The current date is ${today}. Assume this year for any date without one, and resolve relative times against it.`,
    "Extract the tournament setup:",
    "- game_type: the poker variant, e.g. 'NLHE', '5 Card PLO', 'HORSE', 'Big O'.",
    "- tournament_type: map to one of Regular/Satellite/Freeroll/Bounty/Mixed Game/Other (bounty/mystery bounty -> Bounty).",
    "- reentry_allowed: true if re-entries or rebuys are permitted (e.g. 'Unlimited re-entries', 'Re-entry').",
    "- buyin_dollars: the DOLLAR amount in the tournament NAME/title, e.g. '$25 PLO Mystery Bounty' -> 25, '$2,100 ...' -> 2100. This is the real buy-in. Take it from the NAME, NOT the play-money 'Buy-In' field (chips like 20K). Null if no $ in the name.",
    "- start_datetime: the scheduled start as a naive local ISO datetime 'YYYY-MM-DDTHH:MM' (24-hour). E.g. 'Start Time: Aug 02, 11:30' -> '<year>-08-02T11:30'; 'Starts at 19:10 AEST, Aug 2' -> that date at 19:10. Null if you cannot determine an absolute start time.",
    "- late_reg_minutes: total minutes late registration is open AFTER the start. E.g. 'Late Reg. available for 1 h 0 min' -> 60; or (late-reg end time − start time) if both are shown. Null if unknown. Do NOT use a countdown like 'Late Reg Ends in 60:00 left' as the total (that's time remaining now).",
    "- title: the tournament name.",
  ].join("\n");
  return extract(image_base64, media_type, prompt, schema);
}

// The re-entry bracket convention, shared by the entries + results prompts.
const REENTRY_RULE = [
  "RE-ENTRY CONVENTION: a player's screen name can appear MULTIPLE times, each labelled with an entry number in square brackets.",
  "  'Name'      = their 1st entry (no bracket)",
  "  'Name [2]'  = their 2nd entry (a re-entry)",
  "  'Name [3]'  = their 3rd entry",
  "A row may also read 'Name finished' (that entry busted). The SAME nickname may therefore appear up to 3 times.",
  "For EACH UNIQUE player: strip the bracket and any 'finished' text to get their handle, and set reentries = (the highest entry number you see for them) - 1.",
  "  Examples: only 'Name' -> reentries 0;  'Name' + 'Name [2]' -> reentries 1;  a 'Name [3]' present -> reentries 2.",
  "Return exactly ONE object per unique player — never list the same handle twice.",
].join("\n");

// 2) Participants + per-player re-entries from a players-list screenshot.
export function extractEntries(image_base64, media_type, players) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["total_unique", "total_reentries", "players"],
    properties: {
      total_unique: nullable({ type: "integer" }),
      total_reentries: nullable({ type: "integer" }),
      players: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["handle", "reentries", "player_id", "confidence"],
          properties: {
            handle: { type: "string" },
            reentries: { type: "integer" },
            player_id: nullable({ type: "integer" }),
            confidence: CONF,
          },
        },
      },
    },
  };
  const prompt = [
    "This is a screenshot of an online poker tournament players list.",
    REENTRY_RULE,
    "If a summary line shows totals (e.g. 'Unique | Re-entry  45 | 8'), set total_unique=45 and total_reentries=8.",
    "Match each handle to the club roster below. Set player_id to the roster id ONLY when confident (exact or clearly the same handle); otherwise null. Set confidence high/medium/low. Never guess a person — if two roster entries could match, use null.",
    "",
    "ROSTER:",
    rosterText(players),
  ].join("\n");
  return extract(image_base64, media_type, prompt, schema);
}

// 3) Finishing positions + per-player re-entries from a final-results screenshot.
export function extractResults(image_base64, media_type, players) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["players"],
    properties: {
      players: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["handle", "finish_position", "reentries", "play_prize", "player_id", "confidence"],
          properties: {
            handle: { type: "string" },
            finish_position: nullable({ type: "integer" }),
            reentries: { type: "integer" },
            play_prize: nullable({ type: "string" }),
            player_id: nullable({ type: "integer" }),
            confidence: CONF,
          },
        },
      },
    },
  };
  const prompt = [
    "This is a screenshot of an online poker tournament's final results / standings.",
    REENTRY_RULE,
    "For EACH UNIQUE player also extract:",
    "- finish_position: their BEST placement across all their entries — the deepest run, i.e. the LOWEST rank number (1 = winner). A player who re-entered and busted several times keeps only their best finish.",
    "- play_prize: the play-money prize if shown, as text.",
    "Match each handle to the club roster below. Set player_id ONLY when confident; otherwise null. Set confidence high/medium/low. Never guess a person.",
    "",
    "ROSTER:",
    rosterText(players),
  ].join("\n");
  return extract(image_base64, media_type, prompt, schema);
}

// 4) Club GG members list with live chip balances (the club-management screen).
export function extractClubggBalances(image_base64, media_type) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["members"],
    properties: {
      members: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["screen_name", "alias", "gg_id", "chips"],
          properties: {
            screen_name: { type: "string" },
            alias: nullable({ type: "string" }),
            gg_id: nullable({ type: "string" }),
            chips: nullable({ type: "number" }),
          },
        },
      },
    },
  };
  const prompt = [
    "This is a screenshot from the Club GG poker app: a list of club members with their chip balances.",
    "Each member card shows: a bold SCREEN NAME at the top; an id like '(ID : 4560-1858)'; a chip balance shown next to a red poker-chip icon (may have thousands separators and up to 2 decimals, e.g. '2,496.87', '2,000', '1,518'); and an 'Alias' label followed by the member's real name (which may be blank).",
    "Extract EACH member as an object:",
    "- screen_name: the bold screen name exactly.",
    "- alias: the text shown after 'Alias' (their real name), or null if blank.",
    "- gg_id: the id digits e.g. '4560-1858', or null.",
    "- chips: the chip balance as a NUMBER with commas removed, e.g. 2496.87, 2000, 1518.",
    "Return one object per member, in the order shown.",
  ].join("\n");
  return extract(image_base64, media_type, prompt, schema);
}
