#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const rootDir = process.cwd();
const inputPaths = process.argv.slice(2);
const folders = ["ncr"];
const defaultFolders = folders.map((folder) => path.join("unfiltered", folder));
const pathsToScan = inputPaths.length ? inputPaths : defaultFolders;
const FEATURE_COLLECTION_REGEX = /{"type"\s*:\s*"FeatureCollection"/;

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
  if (rawText[index] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = index; i < rawText.length; i += 1) {
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
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const objectText = rawText.slice(index, i + 1);
        return { objectText, endIndex: i + 1 };
      }
    }
  }
  return null;
}

function extractJsonObjectFrom(rawText, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < rawText.length; i += 1) {
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
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
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
    if (featureIndex === -1) {
      break;
    }
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
    } catch (_) {
      // ignore invalid objects
    }
    index = objectMatch.endIndex;
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
          if (leadingObject && leadingObject.type === "Feature") {
            return {
              type: "FeatureCollection",
              features: [leadingObject, ...parsedCandidate.features],
            };
          }
        } catch (error) {
          // fall through to candidate-only repair
        }
      }
      return parsedCandidate;
    } catch (error) {
      // proceed to geo_level fallback
    }
  }

  const featureObjects = extractFeatureObjects(rawText);
  if (featureObjects.length > 0) {
    return {
      type: "FeatureCollection",
      features: featureObjects,
    };
  }

  throw new Error(
    `Invalid JSON in ${filePath}: no FeatureCollection and no feature objects with geo_level were found.`,
  );
}

function fixGeoJson(obj) {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  if (obj.type === "FeatureColletion") {
    obj.type = "FeatureCollection";
  }

  for (const key of Object.keys(obj)) {
    obj[key] = fixGeoJson(obj[key]);
  }

  if (
    obj.type === "FeatureCollection" &&
    obj.features &&
    !Array.isArray(obj.features)
  ) {
    obj.features = [obj.features];
  }

  return obj;
}

function normalizeElement(element) {
  if (Array.isArray(element)) {
    return element.map(normalizeElement);
  }

  if (element === null || typeof element !== "object") {
    return element;
  }

  const preserved = {};
  if (element.type !== undefined) {
    preserved.type = element.type;
  }

  if (element.geometry !== undefined) {
    preserved.geometry = normalizeElement(element.geometry);
  }

  if (element.properties !== undefined) {
    preserved.properties = normalizeElement(element.properties);
  }

  if (element.id !== undefined) {
    preserved.id = element.id;
  }

  for (const key of Object.keys(element)) {
    if (["type", "geometry", "properties", "id"].includes(key)) {
      continue;
    }
    preserved[key] = normalizeElement(element[key]);
  }

  return preserved;
}

function sortFeatures(features) {
  const cityMunLevels = new Set(["Mun", "City"]);
  const cityMun = [];
  const barangays = [];
  const others = [];

  for (const feature of features) {
    const level = feature?.properties?.geo_level;
    if (cityMunLevels.has(level)) {
      cityMun.push(feature);
    } else if (level === "Bgy") {
      barangays.push(feature);
    } else {
      others.push(feature);
    }
  }

  return [...cityMun, ...barangays, ...others];
}

function normalizeGeoJson(data) {
  data = fixGeoJson(data);

  if (data && typeof data === "object" && data.type === "Feature") {
    return {
      type: "FeatureCollection",
      features: [normalizeElement(data)],
    };
  }

  if (data && typeof data === "object" && data.type === "FeatureCollection") {
    const features = Array.isArray(data.features)
      ? data.features.map(normalizeElement)
      : [];

    return {
      ...data,
      features: sortFeatures(features),
    };
  }

  if (data && typeof data === "object" && Array.isArray(data.features)) {
    const features = data.features.map(normalizeElement);
    return {
      ...data,
      type: "FeatureCollection",
      features: sortFeatures(features),
    };
  }

  return data;
}

function formatJson(data) {
  return JSON.stringify(data, null, 2) + "\n";
}

function getOutputPath(filePath) {
  const relativePath = path.relative(rootDir, filePath);
  return path.join(rootDir, "formatted", relativePath);
}

function writeFormattedFile(filePath, content) {
  const outputPath = getOutputPath(filePath);
  ensureDirectory(path.dirname(outputPath));
  fs.writeFileSync(outputPath, content, "utf8");
  return outputPath;
}

function run() {
  const files = collectJsonFiles(pathsToScan);
  if (files.length === 0) {
    console.error("No JSON files found to format.");
    process.exit(1);
  }

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
      fixedCount += 1;
      console.log(`WRITTEN: ${path.relative(rootDir, outputPath)}`);
    } catch (error) {
      failedCount += 1;
      console.error(`FAILED: ${relativePath}`);
      console.error(`  ${error.message}`);
    }
  }

  console.log("---");
  console.log(
    `Processed ${files.length} JSON file(s): ${fixedCount} written, ${failedCount} failed`,
  );
  process.exit(failedCount > 0 ? 2 : 0);
}

run();
