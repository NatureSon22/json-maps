#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const rootDir = process.cwd();
const inputPaths = process.argv.slice(2);

// folders to scan
const folders = ["ncr"];
const defaultFolders = folders.map((folder) => path.join("formatted", folder));

const pathsToScan = inputPaths.length ? inputPaths : defaultFolders;

function isDirectory(p) {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function isJsonFile(p) {
  return path.extname(p).toLowerCase() === ".json";
}

function collectJsonFiles(paths) {
  const results = [];
  for (const input of paths) {
    const resolved = path.resolve(rootDir, input);
    if (!fs.existsSync(resolved)) {
      console.warn(`Skipping missing path: ${input}`);
      continue;
    }

    if (isDirectory(resolved)) {
      const entries = fs.readdirSync(resolved);
      for (const entry of entries) {
        const entryPath = path.join(resolved, entry);
        if (isDirectory(entryPath)) {
          results.push(...collectJsonFiles([entryPath]));
        } else if (isJsonFile(entryPath)) {
          results.push(entryPath);
        }
      }
    } else if (isJsonFile(resolved)) {
      results.push(resolved);
    } else {
      console.warn(`Skipping non-JSON path: ${input}`);
    }
  }
  return results;
}

function parseJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function validateGeoJson(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Top-level JSON is not an object" };
  }

  if (data.type !== "FeatureCollection") {
    return {
      valid: false,
      error: `Expected type "FeatureCollection" but got "${data.type}"`,
    };
  }

  if (!Array.isArray(data.features)) {
    return { valid: false, error: 'Missing or invalid "features" array' };
  }

  const cityOrMun = data.features.find(
    (feature) =>
      feature &&
      feature.properties &&
      (feature.properties.geo_level === "Mun" ||
        feature.properties.geo_level === "City"),
  );

  if (!cityOrMun) {
    return { valid: false, error: "No City/Mun feature found" };
  }

  const barangays = data.features
    .filter(
      (feature) =>
        feature && feature.properties && feature.properties.geo_level === "Bgy",
    )
    .map((feature) => feature.properties.adm4_en)
    .filter(Boolean);

  if (barangays.length === 0) {
    return { valid: false, error: "No Barangay features found" };
  }

  const result = {
    [cityOrMun.properties.geo_level.toLowerCase()]:
      cityOrMun.properties.adm3_en,
    barangays,
    noOfBarangays: barangays.length,
  };

  return {
    valid: true,
    result,
    summary: {
      totalFeatures: data.features.length,
      barangayCount: barangays.length,
    },
  };
}

function run() {
  const files = collectJsonFiles(pathsToScan);

  if (files.length === 0) {
    console.error("No JSON files found to validate.");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const filePath of files) {
    try {
      const data = parseJson(filePath);
      const validation = validateGeoJson(data);

      if (validation.valid) {
        passed += 1;
        console.log(`PASS: ${path.relative(rootDir, filePath)}`);
        console.log(`  ${JSON.stringify(validation.result, null, 2)}`);
      } else {
        failed += 1;
        console.log(`FAIL: ${path.relative(rootDir, filePath)}`);
        console.log(`  Reason: ${validation.error}`);
      }
    } catch (error) {
      failed += 1;
      console.log(`FAIL: ${path.relative(rootDir, filePath)}`);
      console.log(`  JSON parse error: ${error.message}`);
    }
  }

  console.log("---");
  console.log(
    `Checked ${files.length} file(s): ${passed} passed, ${failed} failed`,
  );

  process.exit(failed > 0 ? 2 : 0);
}

run();
