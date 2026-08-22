import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	dependencies: versionizeDeps(["@marianmeres/http-utils"], denoJson),
	// sources are written for Deno's strict type checking; without it tsc
	// cannot narrow the `{ value } | { issues }` unions
	tsconfig: { compilerOptions: { strict: true } },
});
