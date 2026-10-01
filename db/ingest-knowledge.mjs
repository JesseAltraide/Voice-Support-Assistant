import { readFileSync } from "node:fs";
import { adminClient, BRIEF_DIR } from "./lib.mjs";

// Chunk the approved knowledge base by heading. Each "###" entry (including each FAQ
// question) is its own chunk; text under a "##" heading before its first "###" is one
// chunk. Slugs are stable (section--title), so re-ingesting upserts instead of duplicating.
const md = readFileSync(`${BRIEF_DIR}/assets/relaypay-knowledge-base.md`, "utf8").replace(/\r\n/g, "\n");

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const firstSentence = (s) => {
  const flat = s.replace(/\s+/g, " ").replace(/^[-\s]+/, "").trim();
  const m = flat.match(/^(.{20,220}?[.!?])(\s|$)/);
  return (m ? m[1] : flat.slice(0, 200)).trim();
};

const chunks = [];
let section = null;
let title = null;
let buf = [];

function flush() {
  const content = buf.join("\n").trim();
  if (section && title && content) {
    chunks.push({
      slug: `${slugify(section)}--${slugify(title)}`,
      title,
      section,
      content,
      summary: firstSentence(content),
    });
  }
  buf = [];
}

for (const line of md.split("\n")) {
  if (/^# /.test(line)) continue; // document title
  const h2 = line.match(/^## (.+)/);
  const h3 = line.match(/^### (.+)/);
  if (h2) {
    flush();
    section = h2[1].trim();
    title = h2[1].trim(); // intro text under a "##" is titled by the section itself
  } else if (h3) {
    flush();
    title = h3[1].trim();
  } else {
    buf.push(line);
  }
}
flush();

const slugs = new Set();
for (const c of chunks) {
  if (slugs.has(c.slug)) throw new Error(`duplicate slug ${c.slug}`);
  slugs.add(c.slug);
}

const db = adminClient();
const { error } = await db.from("knowledge_chunks").upsert(chunks, { onConflict: "slug" });
if (error) {
  console.error("FAILED knowledge_chunks:", error.message);
  process.exit(1);
}
// Upsert alone never removes anything, so a renamed or deleted section would stay searchable
// and the agent could answer from withdrawn policy. Drop every chunk not in this ingest.
const { data: existing, error: listError } = await db.from("knowledge_chunks").select("slug");
if (listError) {
  console.error("FAILED listing knowledge_chunks:", listError.message);
  process.exit(1);
}
const stale = (existing ?? []).map((r) => r.slug).filter((slug) => !slugs.has(slug));
if (stale.length > 0) {
  const { error: deleteError } = await db.from("knowledge_chunks").delete().in("slug", stale);
  if (deleteError) {
    console.error("FAILED removing stale chunks:", deleteError.message);
    process.exit(1);
  }
  console.log(`removed ${stale.length} stale chunk(s): ${stale.join(", ")}`);
}

const { count } = await db.from("knowledge_chunks").select("*", { count: "exact", head: true });
console.log(`knowledge_chunks: ingested ${chunks.length}, table now holds ${count}`);
