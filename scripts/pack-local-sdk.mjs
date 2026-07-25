#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectories = ["tui", "ai", "agent", "coding-agent"];
const expectedPackageNames = [
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
];

function usage() {
	console.log(`Usage: node scripts/pack-local-sdk.mjs --out <directory> --ref <immutable-commit> [--allow-dirty]

Creates an isolated SDK fixture:
  <directory>/pi/                 archived Pi checkout
  <directory>/tarballs/           packed SDK tarballs
  <directory>/pi-sdk-manifest.json

The output directory must be empty. The current checkout must be clean unless
--allow-dirty is supplied for local debugging.`);
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	return execFileSync(command, args, { stdio: "inherit", ...options });
}

function output(command, args) {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function parseArguments(args) {
	let out;
	let ref;
	let allowDirty = false;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--out" || argument === "--ref") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
			if (argument === "--out") out = resolve(value);
			else ref = value;
			index += 1;
			continue;
		}
		if (argument === "--allow-dirty") {
			allowDirty = true;
			continue;
		}
		if (argument === "--help") {
			usage();
			process.exit(0);
		}
		throw new Error(`Unknown argument: ${argument}`);
	}

	if (!out || !ref) throw new Error("--out and --ref are required");
	return { out, ref, allowDirty };
}

function ensureEmptyOutputDirectory(outputDirectory) {
	if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
		throw new Error(`Output directory must be empty: ${outputDirectory}`);
	}
	mkdirSync(outputDirectory, { recursive: true });
}

function copyModelData(sourceRoot, archivedRoot) {
	const sourceDirectory = join(sourceRoot, "packages/ai/src/providers/data");
	const destinationDirectory = join(archivedRoot, "packages/ai/src/providers/data");
	if (!existsSync(sourceDirectory)) {
		throw new Error(`Generated AI model data is missing: ${sourceDirectory}`);
	}
	cpSync(sourceDirectory, destinationDirectory, { recursive: true });
}

function packWorkspace(archivedRoot, tarballDirectory, workspace) {
	const workspaceDirectory = join(archivedRoot, "packages", workspace);
	const packed = JSON.parse(
		execFileSync(
			process.platform === "win32" ? "npm.cmd" : "npm",
			["pack", "--json", "--ignore-scripts", "--pack-destination", tarballDirectory],
			{ cwd: workspaceDirectory, encoding: "utf8" },
		),
	);
	const filename = packed[0]?.filename;
	if (typeof filename !== "string") throw new Error(`npm pack returned no filename for ${workspace}`);
	return join(tarballDirectory, filename);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageManifestEntry(tarballDirectory, tarball) {
	const packageJson = JSON.parse(
		execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
	);
	if (!expectedPackageNames.includes(packageJson.name)) {
		throw new Error(`Unexpected SDK package in tarball: ${packageJson.name}`);
	}
	if (packageJson.version !== "0.81.1-local.1") {
		throw new Error(`SDK package has unexpected version: ${packageJson.name}@${packageJson.version}`);
	}
	return {
		name: packageJson.name,
		version: packageJson.version,
		path: relative(dirname(tarballDirectory), tarball),
		sha256: sha256(tarball),
	};
}

function main() {
	const { out, ref, allowDirty } = parseArguments(process.argv.slice(2));
	const status = output("git", ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=all"]);
	if (status && !allowDirty) {
		throw new Error("Pi checkout is dirty; commit the SDK contract or pass --allow-dirty for local debugging");
	}

	const commit = output("git", ["-C", repositoryRoot, "rev-parse", "--verify", `${ref}^{commit}`]);
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--ref must resolve to an immutable commit");
	ensureEmptyOutputDirectory(out);

	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-local-sdk-"));
	const archivePath = join(temporaryDirectory, "pi.tar");
	const archivedRoot = join(out, "pi");
	const tarballDirectory = join(out, "tarballs");
	try {
		mkdirSync(archivedRoot, { recursive: true });
		mkdirSync(tarballDirectory, { recursive: true });
		run("git", ["-C", repositoryRoot, "archive", "--format=tar", "--output", archivePath, commit]);
		run("tar", ["-xf", archivePath, "-C", archivedRoot]);
		copyModelData(repositoryRoot, archivedRoot);

		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		run(npm, ["ci", "--ignore-scripts", "--prefix", archivedRoot]);
		for (const workspace of workspaceDirectories) {
			run(npm, ["run", workspace === "ai" ? "build:offline" : "build", "--prefix", join(archivedRoot, "packages", workspace)]);
		}

		const packages = workspaceDirectories
			.map((workspace) => packageManifestEntry(tarballDirectory, packWorkspace(archivedRoot, tarballDirectory, workspace)))
			.sort((left, right) => left.name.localeCompare(right.name));
		if (JSON.stringify(packages.map((entry) => entry.name)) !== JSON.stringify([...expectedPackageNames].sort())) {
			throw new Error("SDK manifest does not contain exactly the four public Pi packages");
		}
		const manifest = {
			schemaVersion: 1,
			forkCommit: commit,
			generatedBy: "scripts/pack-local-sdk.mjs",
			capabilities: {
				modelRuntimeApiVersion: 1,
				providerPayloadCompactionApiVersion: 1,
			},
			packages,
		};
		writeFileSync(join(out, "pi-sdk-manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		console.log(`Wrote ${join(out, "pi-sdk-manifest.json")}`);
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

main();
