#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const validate = require("./validate");

const argv = process.argv.slice(2);
const formatterOnlyMode = argv.includes("--formatter-only");
const validateOnlyMode = argv.includes("--validate-only");

const rootDir = process.cwd();
const formattedDir = path.join(rootDir, "formatted");
const unfilteredDir = path.join(rootDir, "unfiltered");

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

function listSubdirectories(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  return fs
    .readdirSync(rootPath)
    .filter((entry) => {
      const fullPath = path.join(rootPath, entry);
      return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
    })
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function normalizeFolderName(folderName) {
  return normalizeText(String(folderName || ""));
}

function getTerminalWidth() {
  const fallback = 90;
  return process.stdout && process.stdout.columns
    ? process.stdout.columns
    : fallback;
}

function clearScreen() {
  if (process.stdout && process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[0f");
  }
}

function resetFormattedDirectory() {
  const formattedBasename = path.basename(formattedDir).toLowerCase();
  if (formattedBasename !== "formatted") {
    throw new Error("Safety check failed: refusing to clear unexpected folder.");
  }

  fs.rmSync(formattedDir, { recursive: true, force: true });
  fs.mkdirSync(formattedDir, { recursive: true });
}

function wrapLabel(label, width, indent) {
  if (!label || width <= 0) return [label];
  const words = String(label).split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    current = word;
  }

  if (current) {
    lines.push(current);
  }

  return lines.map((line, index) => (index === 0 ? line : `${indent}${line}`));
}

function buildActionEntries() {
  return [
    {
      type: "action",
      label: "Select All",
      action: "select_all",
    },
    {
      type: "action",
      label: "Clear Selection",
      action: "clear_all",
    },
    { type: "spacer" },
  ];
}

function buildRegionEntries(regions) {
  return [
    ...buildActionEntries(),
    ...regions.map((region) => ({
      type: "item",
      label: region,
      value: normalizeFolderName(region),
      selected: false,
    })),
  ];
}

function findMatchingFormattedRoot(regionName, formattedRoots) {
  const normalized = normalizeFolderName(regionName);
  const exact = formattedRoots.find(
    (folder) => normalizeFolderName(folder) === normalized,
  );
  if (exact) return exact;

  return (
    formattedRoots.find(
      (folder) =>
        normalizeFolderName(folder).includes(normalized) ||
        normalized.includes(normalizeFolderName(folder)),
    ) || ""
  );
}

function buildSubfolderEntries(regionName, subfolders) {
  const entries = [...buildActionEntries()];

  if (!subfolders.length) {
    entries.push({
      type: "info",
      label: "(no subfolders found)",
    });
    return entries;
  }

  subfolders.forEach((folder, index) => {
    const isLast = index === subfolders.length - 1;
    const connector = isLast ? "└─" : "├─";
    entries.push({
      type: "item",
      label: `${connector} ${folder}`,
      value: normalizeFolderName(folder),
      selected: false,
    });
  });

  return entries;
}

function renderMenu(chalk, title, breadcrumb, entries, selectedIndex) {
  const lines = [];
  const width = getTerminalWidth();
  const selectedCount = entries.filter(
    (entry) => entry.type === "item" && entry.selected,
  ).length;
  const countLabel = selectedCount
    ? chalk.greenBright.bold(` (${selectedCount} selected)`)
    : "";
  const header = chalk.bgBlue.black(
    chalk.white.bold.underline(` ${title} `) + countLabel,
  );

  lines.push(header);
  if (breadcrumb) {
    lines.push(chalk.dim(` ${breadcrumb}`));
  }
  lines.push(chalk.dim("─".repeat(Math.min(width, 60))));
  lines.push(
    chalk.yellow(
      "↑/↓ navigate  SPACE select  A toggle all  q/r stop  ENTER confirm",
    ),
  );
  lines.push("");

  entries.forEach((entry, index) => {
    if (entry.type === "spacer") {
      lines.push("");
      return;
    }

    const isActive = selectedIndex === index;
    const cursor = isActive ? chalk.bgCyan.black("→") : " ";
    const selectable = entry.type === "item" || entry.type === "action";
    const marker = selectable
      ? entry.selected
        ? isActive
          ? chalk.bgGreen.black("[x]")
          : chalk.green("[x]")
        : isActive
          ? chalk.cyan("[ ]")
          : chalk.dim("[ ]")
      : "   ";

    let label = entry.label;
    if (entry.type === "header") {
      label = chalk.bold.cyan(label);
    } else if (entry.type === "info") {
      label = chalk.dim(label);
    } else if (entry.type === "action") {
      label = isActive
        ? chalk.magentaBright.bold.underline(label)
        : chalk.magenta(label);
    } else if (entry.type === "item") {
      if (entry.selected) {
        label = isActive ? chalk.greenBright.bold(label) : chalk.green(label);
      } else if (isActive) {
        label = chalk.cyanBright(label);
      }
    }

    const basePrefix = `${cursor} ${marker} `;
    const wrapWidth = Math.max(10, width - basePrefix.length - 1);
    const wrapped = wrapLabel(label, wrapWidth, " ".repeat(basePrefix.length));

    wrapped.forEach((line, lineIndex) => {
      if (lineIndex === 0) {
        lines.push(`${basePrefix}${line}`);
      } else {
        lines.push(line);
      }
    });
  });

  return lines.join("\n");
}

function confirmSelections(chalk, selectionState) {
  return new Promise((resolve) => {
    clearScreen();
    const lines = [];
    lines.push(chalk.bold.underline(" Review selections "));
    lines.push("");
    lines.push(chalk.bold("Regions:"));
    selectionState.regions.forEach((region) => {
      const subfolders = selectionState.selections[region] || [];
      const summary = subfolders.length
        ? chalk.green(`${subfolders.length} selected`)
        : chalk.yellow("root only");
      lines.push(`  - ${chalk.cyan(region)} ${summary}`);
      if (subfolders.length) {
        subfolders.forEach((child) => {
          lines.push(`     ${chalk.dim("•")} ${child}`);
        });
      }
    });
    lines.push("");
    lines.push(
      chalk.dim(
        "ENTER to continue, q/r to cancel, any other key to keep selection.",
      ),
    );

    process.stdout.write(lines.join("\n"));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    readline.emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.removeAllListeners("keypress");
      rl.close();
    };

    process.stdin.once("keypress", (str, key) => {
      cleanup();
      if (key.name === "q" || key.name === "r") {
        clearScreen();
        console.log(chalk.yellow("Process cancelled by user."));
        process.exit(0);
      }
      resolve(true);
    });
  });
}

function promptMenu(chalk, title, breadcrumb, entries) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return resolve(
        entries
          .filter((entry) => entry.type === "item")
          .map((entry) => entry.value),
      );
    }

    let activeIndex = entries.findIndex((entry) => entry.type === "action");
    if (activeIndex < 0) {
      activeIndex = entries.findIndex((entry) => entry.type !== "spacer");
    }
    if (activeIndex < 0) activeIndex = 0;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    readline.emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.removeAllListeners("keypress");
      rl.close();
    };

    const updateScreen = () => {
      process.stdout.write("\x1b[2J\x1b[0f");
      process.stdout.write(
        renderMenu(chalk, title, breadcrumb, entries, activeIndex),
      );
    };

    const moveIndex = (delta) => {
      if (!entries.length) return;
      let nextIndex = activeIndex;
      for (let i = 0; i < entries.length; i += 1) {
        nextIndex = (nextIndex + delta + entries.length) % entries.length;
        if (entries[nextIndex].type !== "spacer") {
          break;
        }
      }
      activeIndex = nextIndex;
    };

    const setAllSelected = (value) => {
      entries.forEach((entry) => {
        if (entry.type === "item") {
          entry.selected = value;
        }
      });
    };

    process.stdin.on("keypress", (str, key) => {
      if (key.name === "up" || key.name === "k") {
        moveIndex(-1);
        updateScreen();
        return;
      }
      if (key.name === "down" || key.name === "j") {
        moveIndex(1);
        updateScreen();
        return;
      }
      if (key.name === "space") {
        const active = entries[activeIndex];
        if (active?.type === "item") {
          active.selected = !active.selected;
        } else if (active?.type === "action") {
          if (active.action === "select_all") {
            setAllSelected(true);
          }
          if (active.action === "clear_all") {
            setAllSelected(false);
          }
        }
        updateScreen();
        return;
      }
      if (key.name === "a") {
        const allSelected = entries
          .filter((entry) => entry.type === "item")
          .every((entry) => entry.selected);
        setAllSelected(!allSelected);
        updateScreen();
        return;
      }
      if (key.name === "q" || key.name === "r") {
        cleanup();
        clearScreen();
        console.log(chalk.yellow("Process stopped by user."));
        process.exit(0);
      }
      if (key.name === "return") {
        cleanup();
        const selected = entries
          .filter((entry) => entry.type === "item" && entry.selected)
          .map((entry) => entry.value);
        clearScreen();
        return resolve(selected);
      }
      if (key.name === "c" && key.ctrl) {
        cleanup();
        process.exit(1);
      }
    });

    updateScreen();
  });
}

async function getUserSelections(chalk) {
  const regions = listSubdirectories(unfilteredDir);
  if (!regions.length) {
    return {
      regions: [],
      selections: {},
      unfilteredPaths: [],
      formattedPaths: [],
    };
  }

  const regionEntries = buildRegionEntries(regions);
  const selectedRegionsNormalized = await promptMenu(
    chalk,
    "Step 1 of 4: Select Regions",
    "",
    regionEntries,
  );

  const selectedRegions = regions.filter((region) =>
    selectedRegionsNormalized.includes(normalizeFolderName(region)),
  );

  if (!selectedRegions.length) {
    return {
      regions: [],
      selections: {},
      unfilteredPaths: [],
      formattedPaths: [],
    };
  }

  const selections = {};
  const rootOnlyRegions = new Set();

  for (let index = 0; index < selectedRegions.length; index += 1) {
    const region = selectedRegions[index];
    const subfolderRoot = path.join(unfilteredDir, region);
    const subfolders = listSubdirectories(subfolderRoot);
    if (!subfolders.length) {
      console.log(
        chalk.dim(`No subfolders found for ${region}. Using the region root.`),
      );
      selections[region] = [];
      rootOnlyRegions.add(region);
      continue;
    }

    const entries = buildSubfolderEntries(region, subfolders);
    const breadcrumb = `Step 2 of 4: Select ${region} Subfolders (${index + 1}/${selectedRegions.length})`;
    const selectedSubfoldersNormalized = await promptMenu(
      chalk,
      breadcrumb,
      region,
      entries,
    );

    selections[region] = subfolders.filter((folder) =>
      selectedSubfoldersNormalized.includes(normalizeFolderName(folder)),
    );
  }

  const unfilteredPaths = [];
  const formattedRoots = listSubdirectories(formattedDir);
  const formattedPaths = [];

  Object.entries(selections).forEach(([region, subfolders]) => {
    const regionFormattedRoot = findMatchingFormattedRoot(
      region,
      formattedRoots,
    );
    const regionFormattedPath = regionFormattedRoot
      ? path.join(formattedDir, regionFormattedRoot)
      : null;

    if (rootOnlyRegions.has(region)) {
      unfilteredPaths.push(path.join(unfilteredDir, region));
      if (regionFormattedPath) {
        formattedPaths.push(regionFormattedPath);
      }
      return;
    }

    if (subfolders.length === 0) {
      return;
    }

    subfolders.forEach((subfolder) => {
      unfilteredPaths.push(path.join(unfilteredDir, region, subfolder));
      if (regionFormattedPath) {
        formattedPaths.push(path.join(regionFormattedPath, subfolder));
      }
    });
  });

  return {
    regions: selectedRegions,
    selections,
    unfilteredPaths,
    formattedPaths,
  };
}

async function main() {
  const { default: chalk } = await import("chalk");
  const selectionState = await getUserSelections(chalk);

  if (!selectionState.unfilteredPaths.length) {
    clearScreen();
    console.log(chalk.yellow("No subfolders selected. Nothing to process."));
    return null;
  }

  await confirmSelections(chalk, selectionState);
  clearScreen();

  if (!validateOnlyMode) {
    resetFormattedDirectory();

    const formatterResult = spawnSync(
      process.execPath,
      [path.join(rootDir, "formatter.js"), ...selectionState.unfilteredPaths],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (formatterResult.status !== 0) {
      console.log(
        chalk.yellow(
          "Formatter reported errors. Continuing to validation with successful outputs.",
        ),
      );
    }
  }

  const validationRoots = selectionState.formattedPaths.length
    ? selectionState.formattedPaths
    : validate.getValidationRoots();

  if (!formatterOnlyMode) {
    clearScreen();
    return validate.main(validationRoots);
  }
  return null;
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
