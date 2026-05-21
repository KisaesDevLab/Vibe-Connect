/**
 * Phase 28 follow-up — add `scanner_meta` to `intake_files`.
 *
 * Carries the perspective-correction inputs from the in-browser scanner
 * (four corner points in natural-image pixels + the user's enhancement
 * mode) so the conversion worker can run the warp server-side rather
 * than in iOS Safari's ~250MB JS heap. The column is JSONB-nullable —
 * `kind='file'` and `kind='scanned_image'` uploads from the OS-native
 * camera path (no overlay-driven crop) both land with NULL here.
 *
 * Shape when populated:
 *   {
 *     "quad": {
 *       "topLeft":     {"x": number, "y": number},
 *       "topRight":    {"x": number, "y": number},
 *       "bottomRight": {"x": number, "y": number},
 *       "bottomLeft":  {"x": number, "y": number}
 *     },
 *     "enhanceMode": "color" | "grayscale" | "bw",
 *     "sourceSize":  {"w": number, "h": number}
 *   }
 *
 * Coordinates are in the natural-image pixel frame of the file at
 * stored_path; `sourceSize` is the dimensions the client measured when
 * the user placed the corners so the conversion worker can sanity-check
 * before warping (sharp re-reads dimensions but a mismatch is a useful
 * signal of a corrupted blob).
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('intake_files', (t) => {
    t.jsonb('scanner_meta').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('intake_files', (t) => {
    t.dropColumn('scanner_meta');
  });
};
