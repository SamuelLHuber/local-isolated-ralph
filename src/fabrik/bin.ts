#!/usr/bin/env node
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { run } from "./Cli.js"

const MainLive = Layer.mergeAll(NodeContext.layer)

run(process.argv).pipe(
  Effect.provide(MainLive),
  NodeRuntime.runMain()
)
