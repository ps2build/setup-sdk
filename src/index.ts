import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as cache from "@actions/cache";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

async function main(): Promise<void> {
  const ps2dev = core.getInput("ps2dev", { required: true });
  const version = core.getInput("version") || "latest";
  const force = core.getInput("force").toLowerCase() === "true";
  const components = parseComponents(core.getInput("components"));

  const api =
    version === "latest"
      ? "https://api.github.com/repos/ps2build/ps2build/releases/latest"
      : `https://api.github.com/repos/ps2build/ps2build/releases/tags/${version}`;

  core.info(`Resolving ps2build release: ${version}`);

  const response = await fetch(api);

  if (!response.ok) {
    throw new Error(
      `Failed to query ps2build release: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const release = (await response.json()) as Release;
  const tag = release.tag_name;

  if (!tag) {
    throw new Error("Release did not contain tag_name");
  }

  let assetName: string;

  if (process.platform === "win32" && process.arch === "x64") {
    assetName = `ps2build-${tag}-windows-amd64.exe`;
  } else if (process.platform === "linux" && process.arch === "x64") {
    assetName = `ps2build-${tag}-linux-amd64`;
  } else {
    throw new Error(
      `Unsupported platform: ${process.platform}/${process.arch}`,
    );
  }

  const asset = release.assets.find(
    (candidate) => candidate.name === assetName,
  );

  if (!asset) {
    const available = release.assets
      .map((candidate) => candidate.name)
      .join(", ");

    throw new Error(
      `No ps2build asset '${assetName}' found in release ${tag}.` +
        (available ? ` Available assets: ${available}` : ""),
    );
  }

  let cachedPath = force ? "" : tc.find("ps2build", tag);

  if (cachedPath) {
    core.info(`Found ps2build ${tag} in tool cache.`);
  } else {
    core.info(`Downloading ps2build ${tag}...`);

    const downloadedPath = await tc.downloadTool(asset.browser_download_url);

    if (process.platform !== "win32") {
      fs.chmodSync(downloadedPath, 0o755);
    }

    cachedPath = await tc.cacheFile(downloadedPath, assetName, "ps2build", tag);

    core.info(`Cached ps2build ${tag} at ${cachedPath}`);
  }

  // Install flat (PS2DEV/ps2build, not PS2DEV/bin/ps2build) so root detection resolves to PS2DEV.
  fs.mkdirSync(ps2dev, { recursive: true });

  const executableName =
    process.platform === "win32" ? "ps2build.exe" : "ps2build";

  const executablePath = path.join(ps2dev, executableName);

  // tc.cacheFile and tc.find return the cache directory, not the file.
  const cachedExecutablePath = path.join(cachedPath, assetName);

  fs.copyFileSync(cachedExecutablePath, executablePath);

  if (process.platform !== "win32") {
    fs.chmodSync(executablePath, 0o755);
  }

  core.info(`Installed ps2build to ${executablePath}`);

  core.addPath(ps2dev);

  if (components.length === 0) {
    core.info(
      force ? "Running ps2build update --force..." : "Running ps2build update...",
    );

    const updateArgs = ["update"];

    if (force) {
      updateArgs.push("--force");
    }

    await run(executablePath, updateArgs);
    core.setOutput("version", tag);
    core.info(`setup-sdk completed successfully using ps2build ${tag}`);
    return;
  }

  const sortedComponents = [...components].sort();
  const cachePrefix = `ps2dev-${process.platform}-${process.arch}-${sortedComponents.join("_")}`;
  const cacheKey = `${cachePrefix}-${process.env.GITHUB_RUN_ID ?? Date.now()}`;

  const cacheEnabled = cache.isFeatureAvailable();
  if (!cacheEnabled) {
    core.info("Actions cache is not available on this runner - skipping component cache, updating everything unconditionally.");
  } else if (!force) {
    core.info(`Restoring component cache (prefix: ${cachePrefix})...`);
    const restoredKey = await cache.restoreCache([ps2dev], cacheKey, [cachePrefix]);
    if (restoredKey) {
      core.info(`Restored component cache from key: ${restoredKey}`);
      fs.copyFileSync(cachedExecutablePath, executablePath);
      if (process.platform !== "win32") {
        fs.chmodSync(executablePath, 0o755);
      }
      core.info(`Reinstalled ps2build ${tag} over the restored cache`);
    } else {
      core.info("No matching component cache found - installing from scratch.");
    }
  }

  for (const component of components) {
    if (force) {
      core.info(`Running ps2build update ${component} --force...`);
      await run(executablePath, ["update", component, "--force"]);
      continue;
    }

    const checkOutput = await runCapture(executablePath, ["update", component, "--check"]);
    if (isComponentCurrent(checkOutput, component)) {
      core.info(`${component} is already up to date - skipping.`);
      continue;
    }

    core.info(`Running ps2build update ${component}...`);
    await run(executablePath, ["update", component]);
  }

  if (cacheEnabled) {
    core.info(`Saving component cache (key: ${cacheKey})...`);
    try {
      await cache.saveCache([ps2dev], cacheKey);
    } catch (error) {
      core.warning(`Failed to save component cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  core.setOutput("version", tag);

  core.info(`setup-sdk completed successfully using ps2build ${tag}`);
}

function parseComponents(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        PS2DEV: process.env.PS2DEV,
      },
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to execute ${command}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${path.basename(command)} ${args.join(" ")} ` +
            `failed with exit code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";

    const child = spawn(command, args, {
      env: {
        ...process.env,
        PS2DEV: process.env.PS2DEV,
      },
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to execute ${command}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new Error(
          `${path.basename(command)} ${args.join(" ")} ` +
            `failed with exit code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

function isComponentCurrent(checkOutput: string, component: string): boolean {
  for (const line of checkOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(component)) {
      continue;
    }

    if (/^\S+\s+up to date:\s*\S+\s*$/.test(trimmed)) {
      return true;
    }

    if (/^\S+\s+installed:\s*.+?\s+available:\s*\S+\s*$/.test(trimmed)) {
      return false;
    }
  }

  return false;
}

main().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
