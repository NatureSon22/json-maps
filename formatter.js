const fs = require("fs");
const path = require("path");

const rootDir = process.cwd();
const inputPaths = process.argv.slice(2);
const folders = [
  // "unfiltered/region_3",
  // "unfiltered/NCR",
  "unfiltered/region_4_A",
];
const pathsToScan = inputPaths.length ? inputPaths : folders;

const FEATURE_COLLECTION_REGEX = /{"type"\s*:\s*"FeatureCollection"/;

const ALLOWED_GEO_LEVELS = new Set(["Mun", "City", "Bgy"]);
const GEO_LEVEL_MAP = {
  mun: "Mun",
  municipality: "Mun",
  city: "City",
  bgy: "Bgy",
  brgy: "Bgy",
  barangay: "Bgy",
};

function isDirectory(p) {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function isJsonFile(p) {
  return path.extname(p).toLowerCase() === ".json";
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

function parseJson(rawText, filePath) {
  try {
    return JSON.parse(rawText);
  } catch (error) {
    return repairJson(rawText, filePath);
  }
}

function extractLeadingJsonObject(rawText) {
  let index = 0;
  while (index < rawText.length && /\s/.test(rawText[index])) {
    index += 1;
  }
  if (rawText[index] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = index; i < rawText.length; i++) {
    const char = rawText[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        return {
          objectText: rawText.slice(index, i + 1),
          endIndex: i + 1,
        };
      }
    }
  }
  return null;
}

function extractJsonObjectFrom(rawText, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < rawText.length; i++) {
    const char = rawText[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        return {
          objectText: rawText.slice(startIndex, i + 1),
          endIndex: i + 1,
        };
      }
    }
  }
  return null;
}

function extractFeatureObjects(rawText) {
  const features = [];
  let index = 0;

  while (index < rawText.length) {
    const featureIndex = rawText.indexOf('"type"', index);
    if (featureIndex === -1) break;

    const braceIndex = rawText.lastIndexOf("{", featureIndex);
    if (braceIndex === -1) {
      index = featureIndex + 6;
      continue;
    }

    const objectMatch = extractJsonObjectFrom(rawText, braceIndex);
    if (!objectMatch) {
      index = featureIndex + 6;
      continue;
    }

    try {
      const parsed = JSON.parse(objectMatch.objectText);

      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.properties &&
        parsed.properties.geo_level
      ) {
        features.push(parsed);
      }
    } catch (_) {}

    index = objectMatch.endIndex;
  }

  return features;
}

function extractTopLevelJsonObjects(rawText) {
  const objects = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let startIndex = -1;

  for (let i = 0; i < rawText.length; i++) {
    const char = rawText[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        startIndex = i;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && startIndex !== -1) {
          objects.push(rawText.slice(startIndex, i + 1));
          startIndex = -1;
        }
      }
    }
  }

  return objects;
}

function extractFeaturesFromTopLevelObjects(rawText) {
  const features = [];
  const objectTexts = extractTopLevelJsonObjects(rawText);

  for (const objectText of objectTexts) {
    try {
      const parsed = JSON.parse(objectText);
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      if (
        parsed.type === "FeatureCollection" &&
        Array.isArray(parsed.features)
      ) {
        for (const feature of parsed.features) {
          if (feature?.properties?.geo_level) {
            features.push(feature);
          }
        }
      } else if (parsed.type === "Feature" && parsed?.properties?.geo_level) {
        features.push(parsed);
      }
    } catch (_) {
      // Ignore invalid top-level chunks and continue scanning.
    }
  }

  return features;
}

function repairJson(rawText, filePath) {
  const match = FEATURE_COLLECTION_REGEX.exec(rawText);
  const leading = extractLeadingJsonObject(rawText);

  if (match) {
    const candidate = rawText.slice(match.index);
    try {
      const parsedCandidate = JSON.parse(candidate);

      if (
        leading &&
        leading.endIndex <= match.index &&
        parsedCandidate.type === "FeatureCollection"
      ) {
        try {
          const leadingObject = JSON.parse(leading.objectText);
          if (leadingObject?.type === "Feature") {
            return {
              type: "FeatureCollection",
              features: [leadingObject, ...parsedCandidate.features],
            };
          }
        } catch (_) {}
      }

      return parsedCandidate;
    } catch (_) {}
  }

  const topLevelFeatures = extractFeaturesFromTopLevelObjects(rawText);
  if (topLevelFeatures.length > 0) {
    return {
      type: "FeatureCollection",
      features: topLevelFeatures,
    };
  }

  const featureObjects = extractFeatureObjects(rawText);

  if (featureObjects.length > 0) {
    return {
      type: "FeatureCollection",
      features: featureObjects,
    };
  }

  throw new Error(`Invalid JSON in ${filePath}`);
}

function normalizeGeoLevel(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  return GEO_LEVEL_MAP[key] || null;
}

function collectStandardFeatures(data) {
  if (data?.type === "FeatureCollection" && Array.isArray(data.features)) {
    return data.features;
  }

  if (data?.type === "Feature") {
    return [data];
  }

  if (Array.isArray(data)) {
    return data.flatMap((item) => {
      if (item?.type === "FeatureCollection" && Array.isArray(item.features)) {
        return item.features;
      }
      if (item?.type === "Feature") {
        return [item];
      }
      return [];
    });
  }

  return [];
}

function extractFeaturesDeep(node, output = []) {
  if (Array.isArray(node)) {
    for (const item of node) {
      extractFeaturesDeep(item, output);
    }
    return output;
  }

  if (!node || typeof node !== "object") {
    return output;
  }

  const geoLevel = normalizeGeoLevel(node?.properties?.geo_level);
  if (geoLevel) {
    output.push(node);
    return output;
  }

  if (node.type === "FeatureCollection" && Array.isArray(node.features)) {
    for (const feature of node.features) {
      extractFeaturesDeep(feature, output);
    }
    return output;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      extractFeaturesDeep(value, output);
    }
  }

  return output;
}

function getFeatureLevel(feature) {
  return normalizeGeoLevel(feature?.properties?.geo_level) || "";
}

function getFeatureAdm3Psgc(feature) {
  return feature?.properties?.adm3_psgc;
}

function normalizeFeature(feature) {
  if (!feature || typeof feature !== "object") {
    return null;
  }

  const level = getFeatureLevel(feature);
  if (!ALLOWED_GEO_LEVELS.has(level)) {
    return null;
  }

  const properties =
    feature.properties && typeof feature.properties === "object"
      ? { ...feature.properties, geo_level: level }
      : {};
  const fallbackId =
    level === "Bgy" ? properties.adm4_psgc : properties.adm3_psgc;

  return {
    type: "Feature",
    geometry: feature.geometry || null,
    properties,
    id: feature.id ?? fallbackId ?? null,
  };
}

function sortAndConsolidateFeatures(features) {
  const cityMun = [];
  const barangays = [];

  for (const feature of features) {
    const level = getFeatureLevel(feature);
    if (level === "Mun" || level === "City") {
      cityMun.push(feature);
    } else if (level === "Bgy") {
      barangays.push(feature);
    }
  }

  const anchorAdm3 = getFeatureAdm3Psgc(cityMun[0]);
  const scopedCityMun =
    anchorAdm3 === undefined
      ? cityMun
      : cityMun.filter((feature) => getFeatureAdm3Psgc(feature) === anchorAdm3);
  const scopedBarangays =
    anchorAdm3 === undefined
      ? barangays
      : barangays.filter(
          (feature) => getFeatureAdm3Psgc(feature) === anchorAdm3,
        );

  return [...scopedCityMun, ...scopedBarangays];
}

function normalizeGeoJson(data) {
  // Trust already-correct GeoJSON structure first; only use deep scan as recovery fallback.
  let features = collectStandardFeatures(data);

  if (!features.length) {
    features = extractFeaturesDeep(data);
  }

  features = features.map(normalizeFeature).filter(Boolean);

  return {
    type: "FeatureCollection",
    features: sortAndConsolidateFeatures(features),
  };
}

function formatJson(data) {
  return JSON.stringify(data, null, 2) + "\n";
}

function getOutputPath(filePath) {
  return path.join(rootDir, "formatted", filePath);
}

function writeFormattedFile(filePath, content) {
  const outputPath = getOutputPath(filePath);
  ensureDirectory(path.dirname(outputPath));
  fs.writeFileSync(outputPath, content, "utf8");
  return outputPath;
}

function run() {
  const files = collectJsonFiles(pathsToScan);

  let fixedCount = 0;
  let failedCount = 0;

  for (const filePath of files) {
    const relativePath = path.relative(rootDir, filePath);
    const trimmedPath = relativePath.replace(/^unfiltered[\/\\]/, "");

    try {
      const rawText = fs.readFileSync(filePath, "utf8");
      const data = parseJson(rawText, trimmedPath);
      const normalized = normalizeGeoJson(data);
      const formatted = formatJson(normalized);
      const outputPath = writeFormattedFile(trimmedPath, formatted);

      fixedCount++;
      console.log(`WRITTEN: ${path.relative(rootDir, outputPath)}`);
    } catch (error) {
      failedCount++;
      console.error(`FAILED: ${relativePath}`);
      console.error(`  ${error.message}`);
    }
  }

  console.log("---");
  console.log(
    `Processed ${files.length}: ${fixedCount} written, ${failedCount} failed`,
  );

  process.exit(failedCount > 0 ? 2 : 0);
}

run();
