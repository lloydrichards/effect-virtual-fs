# TypeScript workbench

<!-- impeccable:product-schema 1 -->

## Platform

web, local developer demo

## Stack

React, Vite, Monaco and Effect Atom. Shared Schema HTTP RPC connects an Effect Node server to an Effect-owned Node worker. The worker mounts `@effect-vfs/core` through `@effect-vfs/node`. Runtime: Node 26.11.1 with `--experimental-vfs`; mounted compiler: TypeScript 5.9.3.

## Users

Developers evaluating whether ordinary Node packages can operate on Effect-owned virtual files.

## Product Purpose

Show actual TypeScript reads, emitted JavaScript and native Node execution in one editable workspace. Overlays provide reversible experiments. Caller permissions control source edits, compiler output and inspection.

## Main Flow

Edit either TypeScript file → Compile & Run → inspect generated JavaScript and console output → Save point → experiment → Restore. Separate Compile and Run expose the intermediate output. Advanced caller switching demonstrates denied writes.

## Scope

Two editable source files, generated files read-only, one replaceable save point, Problems, Node output and filesystem Changes. Trusted synchronous CommonJS execution, bounded output, a three-second execution deadline and Stop & restore. One local workspace is shared by tabs.

## Design Direction

A compact developer workbench with a warm light shell, dark green editor, file explorer, source tabs and a lower output panel. Keep the primary action obvious and the infrastructure details secondary. State must distinguish dirty buffers, current builds and historical output.
