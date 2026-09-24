import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { ensureAnonymousUser } from "../src/auth.js";
import { BlobStore } from "../src/db/blobs.js";
import { StoneService } from "../src/stones/service.js";
import { SetService } from "../src/stones/sets-service.js";
import { runCardImport } from "../src/stones/importer.js";
import { buildStandardYuhangFixture } from "../tests/stones-import-fixture.js";

const config = loadConfig({ envFile: "/tmp/stones-walkthrough/app/.env", processEnv: { DATA_ROOT: "/tmp/stones-walkthrough" } });
const db = openDatabase(config.dataRoot);
const user = ensureAnonymousUser(db);
const blobs = new BlobStore(config.dataRoot, db);
const stones = new StoneService({ db, blobs });
const sets = new SetService({ db, blobs, stones });

const fx = buildStandardYuhangFixture();
const pages = fx.pageImages;
const r = runCardImport({ service: stones, blobs, db, pageImages: pages }, fx.draft as never,
  { targetSupplier: "yuhang", ownerId: user.id, supplierDisplayName: "钰航（走查）" });
console.log("import:", JSON.stringify({ created: r.created.length, failed: r.failed.length, pending: r.pendingDowngrades.length, firstFail: r.failed[0] }));


console.log("dataRoot:", config.dataRoot, "skipped:", r.skipped.length);
let created = r.created.slice(0, 12);
if (created.length === 0) {
  // 幂等重跑：从既有库取
  const rows = db.prepare('SELECT resource_id FROM stone_index WHERE supplier=? AND trashed=0 LIMIT 12').all('yuhang') as { resource_id: string }[];
  created = rows.map((x) => x.resource_id);
}
const set = sets.createSet({ ownerId: user.id, name: "走查样品组合", purpose: "S7.7 布局走查",
  members: created.map((id) => ({ stoneRef: id })), origin: { kind: "manual-pick" } });
console.log("set:", JSON.stringify({ resourceId: set.resourceId, members: set.memberCount }));
db.close();
