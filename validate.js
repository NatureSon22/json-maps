#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const Table = require("cli-table3");

const rootDir = process.cwd();
const formattedDir = path.join(rootDir, "formatted");
const cleanDir = path.join(rootDir, "clean");
const unfilteredDir = path.join(rootDir, "unfiltered");
const dataDir = path.join(rootDir, "data");
const formattedFolderAllowlist = [
  // "ncr",
  // "REGION_1",
  // "region_4_A",
];
const firstLevelAllowlist = new Set(["city", "mun"]);
const locationNoiseWords = new Set([
  "city",
  "municipality",
  "mun",
  "of",
  "the",
]);
const nameTokenAliases = {
  gen: "general",
  sto: "santo",
  sta: "santa",
  st: "san",
  baliwag: "baliuag",
  bulacan: "bulakan",
};

function normalizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function tokenizeText(value) {
  if (value === undefined || value === null) {
    return [];
  }

  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function getMeaningfulNameTokens(value) {
  return tokenizeText(value)
    .map((token) => nameTokenAliases[token] || token)
    .filter((token) => !locationNoiseWords.has(token));
}

function normalizeNameTokens(value, options = {}) {
  const { stripYears = false } = options;
  return tokenizeText(value)
    .map((token) => nameTokenAliases[token] || token)
    .filter((token) => !locationNoiseWords.has(token))
    .filter((token) => !(stripYears && /^\d{4}$/.test(token)));
}

function stripProvinceQualifier(value, provinceName) {
  if (!value) {
    return "";
  }

  const normalizedProvince = normalizeText(provinceName || "");
  if (!normalizedProvince) {
    return String(value);
  }

  return String(value).replace(/\(([^)]*)\)/g, (fullMatch, groupValue) => {
    return normalizeText(groupValue) === normalizedProvince ? "" : fullMatch;
  });
}

function getMunicipalityComparisonKey(name, provinceName) {
  const withoutProvinceQualifier = stripProvinceQualifier(name, provinceName);
  const tokens = normalizeNameTokens(withoutProvinceQualifier, {
    stripYears: true,
  });
  return tokens.join("|");
}

function namesLikelyMatch(leftValue, rightValue) {
  const left = normalizeText(leftValue);
  const right = normalizeText(rightValue);

  if (
    left.length > 0 &&
    right.length > 0 &&
    (left.includes(right) || right.includes(left))
  ) {
    return true;
  }

  const leftTokens = normalizeNameTokens(leftValue, { stripYears: true });
  const rightTokens = normalizeNameTokens(rightValue, { stripYears: true });
  if (!leftTokens.length || !rightTokens.length) {
    return false;
  }

  return (
    hasTokenSubset(leftTokens, rightTokens) ||
    hasTokenSubset(rightTokens, leftTokens)
  );
}

function getTokenSignature(value) {
  const tokens = normalizeNameTokens(value, { stripYears: true });
  if (!tokens.length) {
    return "";
  }
  return [...tokens].sort().join("|");
}

function isStrongNameMatch(leftValue, rightValue) {
  const left = normalizeText(leftValue);
  const right = normalizeText(rightValue);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftSignature = getTokenSignature(leftValue);
  const rightSignature = getTokenSignature(rightValue);
  return !!leftSignature && leftSignature === rightSignature;
}

function pickUniqueMatch(candidates, getComparableName, targetName) {
  if (!targetName) {
    return null;
  }

  const strongMatches = candidates.filter((candidate) =>
    isStrongNameMatch(getComparableName(candidate), targetName),
  );
  if (strongMatches.length === 1) {
    return strongMatches[0];
  }
  if (strongMatches.length > 1) {
    return null;
  }

  const looseMatches = candidates.filter((candidate) =>
    namesLikelyMatch(getComparableName(candidate), targetName),
  );
  return looseMatches.length === 1 ? looseMatches[0] : null;
}

function hasTokenSubset(leftTokens, rightTokens) {
  const rightSet = new Set(rightTokens);
  return leftTokens.every((token) => rightSet.has(token));
}

function fuzzyIncludes(expected, actual) {
  const left = normalizeText(expected);
  const right = normalizeText(actual);
  if (
    left.length > 0 &&
    right.length > 0 &&
    (left.includes(right) || right.includes(left))
  ) {
    return true;
  }

  const leftTokens = getMeaningfulNameTokens(expected);
  const rightTokens = getMeaningfulNameTokens(actual);
  if (!leftTokens.length || !rightTokens.length) {
    return false;
  }

  return (
    hasTokenSubset(leftTokens, rightTokens) ||
    hasTokenSubset(rightTokens, leftTokens)
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse JSON: ${error.message}`);
  }
}

function collectJsonFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      results.push(...collectJsonFiles(entryPath));
    } else if (path.extname(entryPath).toLowerCase() === ".json") {
      results.push(entryPath);
    }
  }

  return results;
}

function getValidationRoots() {
  if (!formattedFolderAllowlist.length) {
    return [formattedDir];
  }

  return formattedFolderAllowlist
    .map((folder) => path.join(formattedDir, folder))
    .filter((folderPath) => fs.existsSync(folderPath));
}

function resetCleanDirectory() {
  fs.rmSync(cleanDir, { recursive: true, force: true });
  fs.mkdirSync(cleanDir, { recursive: true });
}

function copyPassedFileToClean(filePath) {
  const relativeFromFormatted = path.relative(formattedDir, filePath);
  const outputPath = path.join(cleanDir, relativeFromFormatted);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(filePath, outputPath);
}

function loadDataSources() {
  const sources = {};
  if (!fs.existsSync(dataDir)) {
    return sources;
  }
  for (const fileName of fs.readdirSync(dataDir)) {
    const ext = path.extname(fileName).toLowerCase();
    if (ext !== ".js" && ext !== ".json") {
      continue;
    }
    const baseName = path.basename(fileName, ext).toLowerCase();
    const filePath = path.join(dataDir, fileName);
    try {
      const data = require(filePath);
      if (data && typeof data === "object") {
        sources[baseName] = data;
      }
    } catch (error) {
      // ignore files that cannot be loaded as data sources
    }
  }
  return sources;
}

function findSourceDataForKey(sources, sourceKey) {
  if (sources[sourceKey]) {
    return sources[sourceKey];
  }

  const normalizedSourceKey = normalizeText(sourceKey);
  for (const [loadedKey, sourceData] of Object.entries(sources)) {
    if (normalizeText(loadedKey) === normalizedSourceKey) {
      return sourceData;
    }
    if (resolveSourceArray(sourceData, sourceKey).length > 0) {
      return sourceData;
    }
  }

  return null;
}

function getSourceKeyFromPath(filePath) {
  const relative = path.relative(formattedDir, filePath);
  const segments = relative.split(path.sep);
  return segments[0].toLowerCase();
}

function getFormattedProvinceFromPath(filePath) {
  const relative = path.relative(formattedDir, filePath);
  const segments = relative.split(path.sep);
  return String(segments[1] || "");
}

function getTopFolderKey(baseDir, filePath) {
  const relative = path.relative(baseDir, filePath);
  const segments = relative.split(path.sep);
  return String(segments[0] || "").toLowerCase();
}

function resolveSourceArray(sourceData, sourceKey) {
  function pickArrayFromObject(obj, keyToMatch) {
    if (!obj || typeof obj !== "object") {
      return [];
    }

    if (Array.isArray(obj[keyToMatch])) {
      return obj[keyToMatch];
    }

    const normalizedTarget = normalizeText(keyToMatch);
    const matchingKey = Object.keys(obj).find(
      (key) => normalizeText(key) === normalizedTarget,
    );
    if (matchingKey && Array.isArray(obj[matchingKey])) {
      return obj[matchingKey];
    }

    const firstArray = Object.values(obj).find((value) => Array.isArray(value));
    return Array.isArray(firstArray) ? firstArray : [];
  }

  if (Array.isArray(sourceData[sourceKey])) return sourceData[sourceKey];
  if (Array.isArray(sourceData)) return sourceData;
  if (Array.isArray(sourceData.municipalities))
    return sourceData.municipalities;
  if (Array.isArray(sourceData.cities)) return sourceData.cities;

  if (sourceData && typeof sourceData === "object") {
    const direct = pickArrayFromObject(sourceData, sourceKey);
    if (direct.length > 0) {
      return direct;
    }

    for (const value of Object.values(sourceData)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }

      const nested = pickArrayFromObject(value, sourceKey);
      if (nested.length > 0) {
        return nested;
      }
    }
  }

  return [];
}

function getRecordName(record) {
  return String(record.cityMuni || record.name || "");
}

function getRecordBarangayCount(record) {
  return Number(
    record.noOfBarangays ??
      record.noOfBrgy ??
      record.no_of_brgy ??
      record.no_of_barangays ??
      0,
  );
}

function getRecordProvinceId(record) {
  const candidate =
    record?.provinceId ?? record?.province_id ?? record?.provinceid;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? numeric : null;
}

function getProvinceIdByName(sourceData, provinceName) {
  if (!provinceName || !sourceData || !Array.isArray(sourceData.provinces)) {
    return null;
  }

  const normalizedProvince = normalizeText(provinceName);
  const match = sourceData.provinces.find(
    (province) => normalizeText(province?.name) === normalizedProvince,
  );

  const numeric = Number(match?.id);
  return Number.isFinite(numeric) ? numeric : null;
}

function getProvinceNameById(sourceData, provinceId) {
  if (provinceId === undefined || provinceId === null) {
    return "";
  }

  const candidates = [];

  if (Array.isArray(sourceData?.provinces)) {
    candidates.push(...sourceData.provinces);
  }

  if (sourceData && typeof sourceData === "object") {
    for (const value of Object.values(sourceData)) {
      if (
        value &&
        typeof value === "object" &&
        Array.isArray(value.provinces)
      ) {
        candidates.push(...value.provinces);
      }
    }
  }

  const numericProvinceId = Number(provinceId);
  const match = candidates.find((province) => {
    const candidateId = Number(province?.id);
    return Number.isFinite(candidateId) && candidateId === numericProvinceId;
  });

  return String(match?.name || "");
}

function getRecordProvince(record, sourceData, sourceKey) {
  if (!record || typeof record !== "object") {
    return sourceKey;
  }

  const explicitProvince =
    record.province ||
    record.province_name ||
    record.provinceName ||
    record.province_en;
  if (explicitProvince) {
    return String(explicitProvince);
  }

  const provinceId =
    record.province_id ?? record.provinceId ?? record.provinceid;
  const provinceFromId = getProvinceNameById(sourceData, provinceId);
  if (provinceFromId) {
    return provinceFromId;
  }

  return sourceKey;
}

function getRelativeFileBase(filePath) {
  return path.basename(filePath, ".json");
}

function getRecordYear(record, sourceKey, unfilteredFileIndex) {
  const name = getRecordName(record);
  if (/(?:^|\D)2019(?:\D|$)/.test(name)) {
    return "2019";
  }

  if (!normalizeText(name)) {
    return "";
  }

  const fileNames = unfilteredFileIndex[sourceKey] || [];
  const matchedFileName = fileNames.find((fileBase) =>
    namesLikelyMatch(name, fileBase),
  );

  return matchedFileName && /(?:^|\D)2019(?:\D|$)/i.test(matchedFileName)
    ? "2019"
    : "";
}

function hasMatchingFormattedFile(record, formattedSet) {
  const expectedName = getRecordName(record);
  if (
    !normalizeText(expectedName) ||
    !formattedSet ||
    formattedSet.size === 0
  ) {
    return false;
  }
  return !!pickUniqueMatch(
    Array.from(formattedSet),
    (fileBase) => String(fileBase || ""),
    expectedName,
  );
}

function buildFormattedIndex(jsonFiles) {
  const index = {};
  for (const filePath of jsonFiles) {
    const sourceKey = getSourceKeyFromPath(filePath);
    const fileBase = path.basename(filePath, ".json");
    if (!index[sourceKey]) {
      index[sourceKey] = new Set();
    }
    index[sourceKey].add(fileBase);
  }
  return index;
}

function buildFormattedProvinceIndex(jsonFiles) {
  const index = {};

  for (const filePath of jsonFiles) {
    const sourceKey = getSourceKeyFromPath(filePath);
    const provinceKey = normalizeText(getFormattedProvinceFromPath(filePath));
    const fileBase = path.basename(filePath, ".json");

    if (!index[sourceKey]) {
      index[sourceKey] = {};
    }
    if (!index[sourceKey][provinceKey]) {
      index[sourceKey][provinceKey] = new Set();
    }

    index[sourceKey][provinceKey].add(fileBase);
  }

  return index;
}

function buildFileNameIndex(jsonFiles, baseDir) {
  const index = {};
  for (const filePath of jsonFiles) {
    const sourceKey = getTopFolderKey(baseDir, filePath);
    const fileBase = path.basename(filePath, ".json");
    if (!index[sourceKey]) {
      index[sourceKey] = [];
    }
    index[sourceKey].push(fileBase);
  }
  return index;
}

function buildSelectedFolderScope(validationRoots, jsonFiles) {
  const selectedSourceKeys = new Set(
    jsonFiles.map((filePath) => getSourceKeyFromPath(filePath)).filter(Boolean),
  );
  const provinceFiltersBySource = new Map();

  for (const rootPath of validationRoots) {
    const relativePath = path.relative(formattedDir, rootPath);
    const segments = relativePath.split(path.sep).filter(Boolean);
    if (!segments.length) {
      continue;
    }

    const sourceKey = normalizeText(segments[0]);
    if (!sourceKey) {
      continue;
    }

    selectedSourceKeys.add(sourceKey);

    // Selecting a source root means include all of its provinces/cities.
    if (segments.length === 1) {
      provinceFiltersBySource.set(sourceKey, null);
      continue;
    }

    if (provinceFiltersBySource.get(sourceKey) === null) {
      continue;
    }

    const provinceKey = normalizeText(segments[1]);
    if (!provinceKey) {
      continue;
    }

    const scopedProvinces = provinceFiltersBySource.get(sourceKey) || new Set();
    scopedProvinces.add(provinceKey);
    provinceFiltersBySource.set(sourceKey, scopedProvinces);
  }

  return { selectedSourceKeys, provinceFiltersBySource };
}

function buildUnfilteredFileEntries(jsonFiles, baseDir) {
  const entries = [];

  for (const filePath of jsonFiles) {
    const sourceKey = getTopFolderKey(baseDir, filePath);
    const relativePath = path
      .relative(baseDir, filePath)
      .split(path.sep)
      .join("/");
    const segments = relativePath.split("/");
    const provinceKey = normalizeText(segments[1] || "");

    entries.push({
      sourceKey,
      provinceKey,
      fileBase: path.basename(filePath, ".json"),
      relativePath,
    });
  }

  return entries;
}

function findUnfilteredMatchesForMunicipality(
  unfilteredEntries,
  sourceKey,
  provinceName,
  municipalityName,
) {
  const targetProvinceKey = normalizeText(provinceName || "");

  const sameSource = unfilteredEntries.filter(
    (entry) => entry.sourceKey === sourceKey,
  );
  const sameProvince = targetProvinceKey
    ? sameSource.filter((entry) => entry.provinceKey === targetProvinceKey)
    : sameSource;
  const searchPool = sameProvince.length > 0 ? sameProvince : sameSource;

  return searchPool
    .filter(
      (entry) =>
        isStrongNameMatch(entry.fileBase, municipalityName) ||
        namesLikelyMatch(entry.fileBase, municipalityName),
    )
    .map((entry) => entry.relativePath)
    .sort((left, right) => left.localeCompare(right));
}

function findSourceRecord(sourceArray, fileBase, firstFeature, provinceIdHint) {
  const sourceCandidates =
    provinceIdHint === null
      ? sourceArray
      : sourceArray.filter(
          (record) => getRecordProvinceId(record) === provinceIdHint,
        );
  const candidateSets = [];

  if (sourceCandidates.length > 0) {
    candidateSets.push(sourceCandidates);
  }
  candidateSets.push(sourceArray);

  const adm3Value = String(firstFeature?.properties?.adm3_en || "");

  for (const recordsToMatch of candidateSets) {
    const byFileBase = pickUniqueMatch(recordsToMatch, getRecordName, fileBase);
    if (byFileBase) {
      return byFileBase;
    }

    const byAdm3 = pickUniqueMatch(recordsToMatch, getRecordName, adm3Value);
    if (byAdm3) {
      return byAdm3;
    }
  }

  return null;
}

function validateFile(filePath, sources, chalk) {
  const relativeFile = path.relative(rootDir, filePath);
  const sourceKey = getSourceKeyFromPath(filePath);
  const sourceData = findSourceDataForKey(sources, sourceKey);
  const fileBase = path.basename(filePath, ".json");

  if (!sourceData) {
    return {
      passed: false,
      message: `No source-of-truth data found for folder '${sourceKey}'.`,
      cityMuni: "",
    };
  }

  const dataArray = resolveSourceArray(sourceData, sourceKey);
  if (!dataArray.length) {
    return {
      passed: false,
      message: `Source-of-truth data for '${sourceKey}' is empty or invalid.`,
      cityMuni: "",
    };
  }

  let json;
  try {
    json = readJsonFile(filePath);
  } catch (error) {
    return { passed: false, message: error.message };
  }

  const features = Array.isArray(json.features) ? json.features : [];
  if (!features.length) {
    return {
      passed: false,
      message: "No features found in formatted JSON file.",
      cityMuni: "",
    };
  }

  const firstFeature = features[0];
  const formattedProvince = getFormattedProvinceFromPath(filePath);
  const provinceIdHint = getProvinceIdByName(sourceData, formattedProvince);
  const actualGeoLevel = String(firstFeature?.properties?.geo_level || "");
  const geoLevelAllowed = firstLevelAllowlist.has(actualGeoLevel.toLowerCase());

  const sourceRecord = findSourceRecord(
    dataArray,
    fileBase,
    firstFeature,
    provinceIdHint,
  );
  if (!sourceRecord) {
    return {
      passed: false,
      message: `Unable to resolve expected city record for '${fileBase}'.`,
      cityMuni: "",
      regionId: firstFeature?.properties?.adm2_psgc || "",
      provinceId: firstFeature?.properties?.adm3_psgc || "",
    };
  }

  const expectedCity = getRecordName(sourceRecord);
  const actualAdm3 = String(firstFeature?.properties?.adm3_en || "");
  const adm3Matches = fuzzyIncludes(expectedCity, actualAdm3);

  const barangayCount = features.filter(
    (feature) =>
      String(feature?.properties?.geo_level || "").toLowerCase() === "bgy",
  ).length;
  const expectedBarangays = getRecordBarangayCount(sourceRecord);
  const diff = Math.abs(barangayCount - expectedBarangays);
  const tolerance = Math.max(1, Math.round(expectedBarangays * 0.05));
  const barangaysMatch =
    expectedBarangays > 0
      ? diff <= tolerance
      : barangayCount === expectedBarangays;

  const failures = [];
  if (!geoLevelAllowed) {
    failures.push(
      `expected first feature geo_level to be 'City' or 'Mun' but found '${actualGeoLevel || "<missing>"}'.`,
    );
  }
  if (!adm3Matches) {
    failures.push(
      `expected adm3_en to match '${expectedCity}' but found '${actualAdm3 || "<missing>"}'.`,
    );
  }
  if (!barangaysMatch) {
    failures.push(
      `expected noOfBarangays ${expectedBarangays} but found ${barangayCount} Bgy features (tolerance ±${tolerance}).`,
    );
  }

  if (failures.length === 0) {
    return {
      passed: true,
      message: `PASS ${relativeFile}`,
      cityMuni: expectedCity,
      adm3Name: actualAdm3,
      regionId: firstFeature?.properties?.adm2_psgc || "",
      provinceId: firstFeature?.properties?.adm3_psgc || "",
    };
  }

  return {
    passed: false,
    message: failures.join(" "),
    cityMuni: adm3Matches ? expectedCity : "",
    adm3Name: actualAdm3,
    regionId: firstFeature?.properties?.adm2_psgc || "",
    provinceId: firstFeature?.properties?.adm3_psgc || "",
  };
}

function makeStatusLabel(passed, chalk) {
  return passed ? chalk.bgGreen.black(" PASS ") : chalk.bgRed.white(" FAIL ");
}

function makeSummaryLabel(
  passedCount,
  failedCount,
  missingCount,
  total,
  chalk,
) {
  if (failedCount === 0 && missingCount === 0) {
    return chalk.bgGreen.black(` ${passedCount}/${total} passed `);
  }
  if (failedCount === 0 && missingCount > 0) {
    return chalk.bgYellow.black(
      ` ${passedCount}/${total} passed, ${missingCount} missing `,
    );
  }
  return chalk.bgRed.white(
    ` ${passedCount}/${total} passed, ${failedCount} failed, ${missingCount} missing `,
  );
}

async function main(rootPaths = []) {
  const { default: chalk } = await import("chalk");
  const sources = loadDataSources();
  const validationRoots =
    rootPaths.length > 0 ? rootPaths : getValidationRoots();
  const jsonFiles = validationRoots.flatMap((rootPath) =>
    collectJsonFiles(rootPath),
  );
  const { selectedSourceKeys, provinceFiltersBySource } =
    buildSelectedFolderScope(validationRoots, jsonFiles);
  const formattedIndex = buildFormattedIndex(jsonFiles);
  const formattedProvinceIndex = buildFormattedProvinceIndex(jsonFiles);
  const unfilteredFiles = collectJsonFiles(unfilteredDir);
  const unfilteredFileIndex = buildFileNameIndex(
    unfilteredFiles,
    unfilteredDir,
  );
  const unfilteredEntries = buildUnfilteredFileEntries(
    unfilteredFiles,
    unfilteredDir,
  );

  if (!jsonFiles.length) {
    console.error(chalk.red("No JSON files found in the formatted folder."));
    process.exit(1);
  }

  resetCleanDirectory();

  const passedFiles = [];
  const failedFiles = [];
  const missingFiles = [];
  const inspectedFiles = [];

  for (const filePath of jsonFiles) {
    const result = validateFile(filePath, sources, chalk);
    const relativePath = path.relative(rootDir, filePath);
    const sourceKey = getSourceKeyFromPath(filePath);
    const label = makeStatusLabel(result.passed, chalk);

    if (result.passed) {
      const fileBase = getRelativeFileBase(relativePath);
      passedFiles.push({
        file: relativePath,
        base: fileBase,
        cityMuni: result.cityMuni || "",
        adm3Name: result.adm3Name || "",
      });
      copyPassedFileToClean(filePath);
      console.log(`${label} ${chalk.whiteBright.bold(relativePath)}`);
    } else {
      failedFiles.push({
        file: relativePath,
        cityMuni: result.cityMuni || "",
        adm3Name: result.adm3Name || "",
        reason: result.message,
        regionId: result.regionId || "-",
        provinceId: result.provinceId || "-",
      });
      console.log(`${label} ${chalk.whiteBright.bold(relativePath)}`);
      console.log(chalk.bgBlack.white(`  ${result.message} `));
    }

    inspectedFiles.push({
      file: relativePath,
      sourceKey,
      provinceKey: normalizeText(getFormattedProvinceFromPath(filePath)),
      provinceName: getFormattedProvinceFromPath(filePath),
      adm3Name: result.adm3Name || "",
      cityMuni: result.cityMuni || "",
      passed: result.passed,
    });

    console.log();
  }

  console.log("---");
  console.log();

  for (const [sourceKey, sourceData] of Object.entries(sources)) {
    const normalizedSourceKey = normalizeText(sourceKey);
    if (
      selectedSourceKeys.size > 0 &&
      !selectedSourceKeys.has(normalizedSourceKey)
    ) {
      continue;
    }

    const dataArray = resolveSourceArray(sourceData, sourceKey);
    for (const record of dataArray) {
      if (!record || !getRecordName(record)) {
        continue;
      }

      const provinceName = getRecordProvince(record, sourceData, sourceKey);
      const provinceKey = normalizeText(provinceName);
      const provinceFilter = provinceFiltersBySource.get(normalizedSourceKey);
      if (
        provinceFilter instanceof Set &&
        provinceFilter.size > 0 &&
        !provinceFilter.has(provinceKey)
      ) {
        continue;
      }

      const expectedKey = getMunicipalityComparisonKey(
        getRecordName(record),
        provinceName,
      );
      const provinceScopedMatch = inspectedFiles.some((file) => {
        if (file.sourceKey !== sourceKey || file.provinceKey !== provinceKey) {
          return false;
        }

        const formattedFileBase = getRelativeFileBase(file.file);
        const adm3Key = getMunicipalityComparisonKey(
          file.adm3Name,
          file.provinceName,
        );
        const fileBaseKey = getMunicipalityComparisonKey(
          formattedFileBase,
          file.provinceName,
        );
        const likelyNameMatch =
          namesLikelyMatch(file.adm3Name, getRecordName(record)) ||
          namesLikelyMatch(formattedFileBase, getRecordName(record));

        return (
          adm3Key === expectedKey ||
          fileBaseKey === expectedKey ||
          likelyNameMatch
        );
      });
      const sourceScopedMatch = inspectedFiles.some((file) => {
        if (file.sourceKey !== sourceKey) {
          return false;
        }

        const formattedFileBase = getRelativeFileBase(file.file);
        const adm3Key = getMunicipalityComparisonKey(
          file.adm3Name,
          file.provinceName,
        );
        const fileBaseKey = getMunicipalityComparisonKey(
          formattedFileBase,
          file.provinceName,
        );
        const likelyNameMatch =
          namesLikelyMatch(file.adm3Name, getRecordName(record)) ||
          namesLikelyMatch(formattedFileBase, getRecordName(record));

        return (
          adm3Key === expectedKey ||
          fileBaseKey === expectedKey ||
          likelyNameMatch
        );
      });

      if (!provinceScopedMatch && !sourceScopedMatch) {
        missingFiles.push({
          source: sourceKey,
          province: provinceName,
          year: getRecordYear(record, sourceKey, unfilteredFileIndex),
          expected: getRecordName(record),
        });
      }
    }
  }

  const overlapFiles = [];
  const overlapSeen = new Set();
  const missingKeys = new Set(
    missingFiles
      .map(
        (item) =>
          `${normalizeText(item.province || "")}|${getMunicipalityComparisonKey(item.expected, item.province)}`,
      )
      .filter((key) => key.split("|")[1]),
  );

  for (const missing of missingFiles) {
    const expectedName = String(missing.expected || "");
    const expectedProvinceKey = normalizeText(missing.province || "");
    const expectedMunicipalityKey = getMunicipalityComparisonKey(
      expectedName,
      missing.province,
    );
    if (!expectedMunicipalityKey) {
      continue;
    }

    for (const passed of passedFiles) {
      const passedFile = inspectedFiles.find(
        (item) => item.file === passed.file,
      );
      if (!passedFile) {
        continue;
      }

      const passedProvinceKey = normalizeText(passedFile.provinceName || "");
      const passedMunicipalityKey = getMunicipalityComparisonKey(
        passed.cityMuni || passedFile.adm3Name || "",
        passedFile.provinceName,
      );

      if (
        passedProvinceKey !== expectedProvinceKey ||
        passedMunicipalityKey !== expectedMunicipalityKey
      ) {
        continue;
      }

      const key = `${passed.file}::${missing.source}::${expectedProvinceKey}::${expectedMunicipalityKey}`;
      if (overlapSeen.has(key)) {
        continue;
      }
      overlapSeen.add(key);
      overlapFiles.push({
        file: passed.file,
        source: missing.source,
        province: missing.province || "-",
        expected: expectedName,
      });
    }
  }

  const duplicatePassedOverlaps = [];
  const passedByMunicipalityKey = new Map();
  for (const passed of passedFiles) {
    const passedFile = inspectedFiles.find((item) => item.file === passed.file);
    if (!passedFile) {
      continue;
    }

    const provinceKey = normalizeText(passedFile.provinceName || "");
    const municipalityKey = getMunicipalityComparisonKey(
      passed.cityMuni || passedFile.adm3Name || "",
      passedFile.provinceName,
    );
    if (!provinceKey || !municipalityKey) {
      continue;
    }

    const scopedKey = `${provinceKey}|${municipalityKey}`;

    const grouped = passedByMunicipalityKey.get(scopedKey) || [];
    grouped.push(passed);
    passedByMunicipalityKey.set(scopedKey, grouped);
  }

  for (const [scopedKey, groupedPassed] of passedByMunicipalityKey.entries()) {
    if (groupedPassed.length <= 1 || missingKeys.has(scopedKey)) {
      continue;
    }

    const [primary, ...extras] = groupedPassed;
    const primaryFile = inspectedFiles.find(
      (item) => item.file === primary.file,
    );

    for (const extra of extras) {
      const extraFile = inspectedFiles.find((item) => item.file === extra.file);
      const sourceKey = extraFile?.sourceKey || primaryFile?.sourceKey || "";
      const provinceName =
        extraFile?.provinceName || primaryFile?.provinceName || "";
      const municipalityName =
        extra.cityMuni || extraFile?.adm3Name || primary.cityMuni || "";
      const unfilteredMatches = findUnfilteredMatchesForMunicipality(
        unfilteredEntries,
        sourceKey,
        provinceName,
        municipalityName,
      );

      duplicatePassedOverlaps.push({
        file: extra.file,
        municipality: municipalityName,
        unfilteredMatches,
      });
    }
  }

  if (passedFiles.length) {
    const passTable = new Table({
      head: [chalk.whiteBright("Passed Files")],
      style: { head: ["green"] },
      colWidths: [80],
      wordWrap: true,
    });
    passedFiles.forEach((item) => passTable.push([chalk.green(item.file)]));
    console.log(chalk.bold.green("Passed files"));
    console.log(passTable.toString());
    console.log();
  }

  if (failedFiles.length) {
    const failTable = new Table({
      head: [
        chalk.whiteBright("Failed File"),
        chalk.whiteBright("Muni/City"),
        chalk.whiteBright("Region ID"),
        chalk.whiteBright("Province ID"),
        chalk.whiteBright("Reason"),
      ],
      style: { head: ["red"] },
      colWidths: [42, 20, 12, 12, 34],
      wordWrap: true,
    });
    failedFiles.forEach((item) =>
      failTable.push([
        chalk.red(item.file),
        chalk.yellow(item.cityMuni || ""),
        chalk.yellow(item.regionId || "-"),
        chalk.yellow(item.provinceId || "-"),
        chalk.yellow(item.reason),
      ]),
    );
    console.log(chalk.bold.red("Failed files"));
    console.log(failTable.toString());
    console.log();
  }

  if (missingFiles.length) {
    const missingTable = new Table({
      head: [
        chalk.whiteBright("Source"),
        chalk.whiteBright("Province"),
        chalk.whiteBright("Year"),
        chalk.whiteBright("Missing City/Muni"),
      ],
      style: { head: ["yellow"] },
      colWidths: [16, 20, 8, 44],
      wordWrap: true,
    });
    missingFiles.forEach((item) =>
      missingTable.push([
        chalk.yellow(item.source),
        chalk.yellow(item.province || "-"),
        chalk.yellow(item.year || ""),
        chalk.yellow(item.expected),
      ]),
    );
    console.log(chalk.bold.yellow("Missing records"));
    console.log(missingTable.toString());
    console.log();
  }

  if (overlapFiles.length) {
    const overlapTable = new Table({
      head: [
        chalk.whiteBright("Passed File"),
        chalk.whiteBright("Missing Source"),
        chalk.whiteBright("Province"),
        chalk.whiteBright("Missing Municipality"),
      ],
      style: { head: ["magenta"] },
      colWidths: [42, 16, 20, 44],
      wordWrap: true,
    });

    overlapFiles.forEach((item) =>
      overlapTable.push([
        chalk.magenta(item.file),
        chalk.magenta(item.source),
        chalk.magenta(item.province || "-"),
        chalk.magenta(item.expected),
      ]),
    );

    console.log(
      chalk.bold.magenta("Passed files that overlap missing records"),
    );
    console.log(overlapTable.toString());
    console.log();
  }

  if (duplicatePassedOverlaps.length) {
    const duplicatePassTable = new Table({
      head: [
        chalk.whiteBright("Duplicate Passed File"),
        chalk.whiteBright("Municipality"),
        chalk.whiteBright("Files with Similar Municipality (/unfiltered)"),
      ],
      style: { head: ["magenta"] },
      colWidths: [40, 22, 46],
      wordWrap: true,
    });

    duplicatePassedOverlaps.forEach((item) =>
      duplicatePassTable.push([
        chalk.magenta(item.file),
        chalk.magenta(item.municipality || ""),
        chalk.magenta(
          item.unfilteredMatches.length
            ? item.unfilteredMatches.join("\n")
            : "-",
        ),
      ]),
    );

    console.log(chalk.bold.magenta("Duplicate passed municipality mappings"));
    console.log(duplicatePassTable.toString());
    console.log();
  }

  const totalOverlaps = overlapFiles.length + duplicatePassedOverlaps.length;

  const summaryTable = new Table({
    head: [chalk.whiteBright("Metric"), chalk.whiteBright("Count")],
    style: { head: ["cyan"] },
    colWidths: [30, 20],
  });
  summaryTable.push(["Total files", chalk.white(String(jsonFiles.length))]);
  summaryTable.push(["Passed", chalk.green(String(passedFiles.length))]);
  summaryTable.push(["Failed", chalk.red(String(failedFiles.length))]);
  summaryTable.push(["Missing", chalk.yellow(String(missingFiles.length))]);
  summaryTable.push([
    "Overlaps (Missing+Duplicate)",
    chalk.magenta(String(totalOverlaps)),
  ]);

  console.log(chalk.bold.white("Summary"));
  console.log(summaryTable.toString());
  console.log();
  console.log(
    makeSummaryLabel(
      passedFiles.length,
      failedFiles.length,
      missingFiles.length,
      jsonFiles.length,
      chalk,
    ),
  );

  process.exit(failedFiles.length > 0 || missingFiles.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}

module.exports = {
  collectJsonFiles,
  loadDataSources,
  resolveSourceArray,
  getSourceKeyFromPath,
  validateFile,
  getValidationRoots,
  buildFormattedIndex,
  buildFormattedProvinceIndex,
  buildFileNameIndex,
  resetCleanDirectory,
  copyPassedFileToClean,
  getRecordName,
  getRecordBarangayCount,
  getRecordProvince,
  getRecordProvinceId,
  getProvinceIdByName,
  getProvinceNameById,
  main,
};
