import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedPackageNames = new Set([
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
]);
const sortedExpectedPackageNames = [...expectedPackageNames].sort();
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, options = {}) {
	return execFileSync(command, args, { stdio: "inherit", ...options });
}

/** Read and validate the SDK manifest before a consumer installs any tarball. */
export function readLocalSdkManifest(manifestPath) {
	const absoluteManifestPath = resolve(manifestPath);
	const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
	if (
		manifest.schemaVersion !== 1 ||
		typeof manifest.sdkVersion !== "string" ||
		manifest.capabilities?.extensionSdkApiVersion !== 1 ||
		manifest.capabilities?.retryPolicySnapshotApiVersion !== 1 ||
		manifest.capabilities?.compactionFailureResultApiVersion !== 1 ||
		!Array.isArray(manifest.packages)
	) {
		throw new Error(`Invalid Pi SDK manifest: ${absoluteManifestPath}`);
	}
	const manifestPackageNames = manifest.packages.map((entry) => entry?.name).sort();
	if (JSON.stringify(manifestPackageNames) !== JSON.stringify(sortedExpectedPackageNames)) {
		throw new Error("Pi SDK manifest must contain exactly the four expected packages");
	}

	const manifestDirectory = resolve(absoluteManifestPath, "..");
	const packages = manifest.packages.map((entry) => {
		if (!expectedPackageNames.has(entry.name) || entry.version !== manifest.sdkVersion) {
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

/** Populate an empty directory with the canonical <temp>/pi and <temp>/project layout. */
export function prepareLocalForkFixture({ out, ref, piDirectory = repositoryRoot }) {
	const root = resolve(out);
	if (existsSync(root) && readdirSync(root).length > 0) {
		throw new Error(`Fixture output directory must be empty: ${root}`);
	}
	run(process.execPath, [join(resolve(piDirectory), "scripts/pack-local-sdk.mjs"), "--out", root, "--ref", ref]);
	const projectDirectory = join(root, "project");
	mkdirSync(projectDirectory, { recursive: true });
	return {
		root,
		piDirectory: join(root, "pi"),
		projectDirectory,
		manifestPath: join(root, "pi-sdk-manifest.json"),
		manifest: readLocalSdkManifest(join(root, "pi-sdk-manifest.json")),
	};
}

/** Create a fixture with the canonical <temp>/pi and <temp>/project layout. */
export function createLocalForkFixture({ ref, piDirectory = repositoryRoot, prefix = "pi-local-fork-" }) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	try {
		return prepareLocalForkFixture({ out: root, ref, piDirectory });
	} catch (error) {
		rmSync(root, { force: true, recursive: true });
		throw error;
	}
}

/** Install the verified SDK tarballs directly into an existing project copy. */
export function installManifestSdk(projectDirectory, manifest) {
	run(npmCommand(), [
		"install",
		"--ignore-scripts",
		"--legacy-peer-deps",
		"--no-save",
		"--no-fund",
		"--no-audit",
		"--prefix",
		resolve(projectDirectory),
		...manifest.packages.map((entry) => entry.tarball),
	]);
}

/** Create and install a clean consumer whose SDK dependencies come from the manifest. */
export function createManifestConsumer(consumerDirectory, manifest, dependencies = {}) {
	const directory = resolve(consumerDirectory);
	mkdirSync(directory, { recursive: true });
	for (const name of Object.keys(dependencies)) {
		if (expectedPackageNames.has(name)) {
			throw new Error(`Manifest SDK dependency cannot be overridden: ${name}`);
		}
	}
	writeFileSync(
		join(directory, "package.json"),
		`${JSON.stringify(
			{
				private: true,
				type: "module",
				dependencies: {
					...Object.fromEntries(manifest.packages.map((entry) => [entry.name, `file:${entry.tarball}`])),
					...dependencies,
				},
			},
			null,
			2,
		)}\n`,
	);
	run(npmCommand(), [
		"install",
		"--ignore-scripts",
		"--legacy-peer-deps",
		"--no-fund",
		"--no-audit",
		"--prefix",
		directory,
	]);
}

function cliOption(arguments_, name, multiple = false) {
	const values = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		if (arguments_[index] !== name) continue;
		const value = arguments_[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
		values.push(value);
		index += 1;
	}
	if (multiple) return values;
	if (values.length !== 1) throw new Error(`${name} is required exactly once`);
	return values[0];
}

function runCli() {
	const [command, ...arguments_] = process.argv.slice(2);
	if (command === "prepare") {
		prepareLocalForkFixture({
			out: cliOption(arguments_, "--out"),
			ref: cliOption(arguments_, "--ref"),
		});
		return;
	}
	if (command === "install-sdk") {
		const manifest = readLocalSdkManifest(cliOption(arguments_, "--manifest"));
		installManifestSdk(cliOption(arguments_, "--prefix"), manifest);
		return;
	}
	if (command === "create-consumer") {
		const dependencies = Object.fromEntries(
			cliOption(arguments_, "--dependency", true).map((entry) => {
				const separator = entry.indexOf("=");
				if (separator <= 0 || separator === entry.length - 1) {
					throw new Error(`--dependency must be name=specifier: ${entry}`);
				}
				return [entry.slice(0, separator), entry.slice(separator + 1)];
			}),
		);
		createManifestConsumer(
			cliOption(arguments_, "--directory"),
			readLocalSdkManifest(cliOption(arguments_, "--manifest")),
			dependencies,
		);
		return;
	}
	throw new Error("Usage: local-fork-fixture.mjs <prepare|install-sdk|create-consumer> ...");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	runCli();
}
