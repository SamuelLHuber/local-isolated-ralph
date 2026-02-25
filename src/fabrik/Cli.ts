import * as Command from "@effect/cli/Command"
import * as Options from "@effect/cli/Options"
import * as Effect from "effect/Effect"
import * as Console from "effect/Console"
import { listSpecs, minifySpecs, validateSpecs } from "./specs.js"
import { CLI_VERSION } from "./version.js"

const specsDirOption = Options.text("specs-dir").pipe(
  Options.withDefault("specs"),
  Options.withDescription("Directory containing spec/todo JSON files")
)

const listCommand = Command.make(
  "list",
  { specsDir: specsDirOption },
  ({ specsDir }) =>
    Effect.try({
      try: () => listSpecs(specsDir),
      catch: (error) => new Error(String(error))
    }).pipe(
      Effect.flatMap((specs) =>
        Console.log(
          specs
            .map((spec) => `${spec.id}${spec.status ? ` (${spec.status})` : ""} -> ${spec.path}`)
            .join("\n")
        )
      )
    )
).pipe(Command.withDescription("List specs in a directory"))

const validateCommand = Command.make(
  "validate",
  { specsDir: specsDirOption },
  ({ specsDir }) =>
    Effect.try({
      try: () => validateSpecs(specsDir),
      catch: (error) => new Error(String(error))
    }).pipe(Effect.flatMap(() => Console.log("✅ specs validated")))
).pipe(Command.withDescription("Validate spec/todo JSON against the schema"))

const minifyCommand = Command.make(
  "minify",
  { specsDir: specsDirOption },
  ({ specsDir }) =>
    Effect.try({
      try: () => minifySpecs(specsDir),
      catch: (error) => new Error(String(error))
    }).pipe(Effect.flatMap(() => Console.log("✅ specs minified")))
).pipe(Command.withDescription("Write *.min.json for all specs/todos"))

const specCommand = Command.make("spec").pipe(
  Command.withSubcommands([listCommand, validateCommand, minifyCommand])
)

const versionCommand = Command.make("version", {}, () => Console.log(CLI_VERSION)).pipe(
  Command.withDescription("Print CLI version")
)

const cli = Command.make("fabrik").pipe(
  Command.withSubcommands([specCommand, versionCommand])
)

export const run = (argv: string[]) => Command.run(cli, { name: "fabrik", version: CLI_VERSION })(argv)
