import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const expectedPackageNames = new Set([
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
]);

/** Read and validate the SDK manifest before a consumer installs any tarball. */
export function readLocalSdkManifest(manifestPath) {
	const absoluteManifestPath = resolve(manifestPath);
	const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
	if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
		throw new Error(`Invalid Pi SDK manifest: ${absoluteManifestPath}`);
	}
	if (manifest.packages.length !== expectedPackageNames.size) {
		throw new Error("Pi SDK manifest must contain exactly four packages");
	}

	const manifestDirectory = resolve(absoluteManifestPath, "..");
	const packages = manifest.packages.map((entry) => {
		if (!expectedPackageNames.has(entry.name) || entry.version !== "0.81.1-local.1") {
			throw new Error(`Invalid Pi SDK manifest package: ${entry.name}@${entry.version}`);
		}
		if (typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
			throw new Error(`Invalid Pi SDK manifest entry: ${entry.name}`);
		}
		const tarball = resolve(manifestDirectory, entry.path);
		if (!existsSync(tarball)) throw new Error(`Pi SDK tarball is missing: ${tarball}`);
		const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
		if (digest !== entry.sha256) throw new Error(`Pi SDK tarball digest mismatch: ${entry.name}`);
		return { name: entry.name, version: entry.version, tarball };
	});

	return { ...manifest, packages };
}

/** Build direct dependency entries for a clean positive consumer fixture. */
export function localSdkConsumerDependencies(manifestPath) {
	return Object.fromEntries(
		readLocalSdkManifest(manifestPath).packages.map((entry) => [entry.name, `file:${entry.tarball}`]),
	);
}
