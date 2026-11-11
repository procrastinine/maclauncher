---
title: Existing bottles and wrappers
description: "Running a Windows game in a CrossOver bottle or Sikarugir wrapper you already have on your Mac, from MacLauncher: what MacLauncher reads and changes there, how Stop works, and why your bottles are never deleted or replaced."
head:
  - tag: title
    content: "Use existing CrossOver bottles and Sikarugir wrappers on Mac | MacLauncher"
sidebar:
  order: 6
---

If you've used CrossOver or Sikarugir before, you may already have a game installed and set up in a CrossOver bottle or a Sikarugir wrapper. MacLauncher can run the game right there, so you get its graphics effects, translator choices and settings without moving anything.

## Choosing a bottle or wrapper

Open the game's **Runtime Settings** and look at **Environment**. Besides **Private (MacLauncher)**, which is the default, it lists the bottles and wrappers MacLauncher finds on your Mac:

- CrossOver bottles from CrossOver's bottle folder, wherever CrossOver's configuration or preferences put it, or the standard Bottles folder otherwise. Published and stub bottles aren't listed.
- Sikarugir wrappers in `~/Applications/Sikarugir`.

**Choose…** picks a bottle or wrapper anywhere else. Finding and reading them all happens offline, without starting WINE.

WineCX has no bottle or wrapper format of its own, so its games always run in a private Windows environment and don't show **Environment**.

## What MacLauncher does with it

MacLauncher stores only a reference to the bottle or wrapper and uses it where it is. It never copies, adopts, recreates, moves, replaces or deletes it. If the bottle has gone missing or is incomplete, the game reports an error instead of creating a new one, and removing the game from your library leaves the bottle as it was.

A wrapper is run with its own WINE engine, Windows environment and support files. MacLauncher doesn't run the wrapper's own launcher, custom shell commands or startup scripts, though, so anything those do won't happen.

Each [runtime setting](/maclauncher/windows/settings/) starts at **Bottle setting** or **Wrapper setting** and shows the value currently stored there. Leave it that way and MacLauncher changes nothing. Choose **Custom setting** for a control to override it, and that value is written into the bottle, for example into its Windows registry. The same goes for [graphics translators](/maclauncher/windows/graphics-translators/): a translator you pick explicitly may place its DLLs in the bottle, and any DLL it replaces is set aside and put back when you switch away. Logs stay in MacLauncher's own folder.

**Open Windows files** opens the bottle, and its Windows user folders show up as save locations in the game's save tools.

## Stopping a game

A bottle can have other Windows programs running in it, so **Stop** ends only the game's own processes. To close everything, use **Close All Applications**, which asks before it closes the bottle's other programs and forces any that remain to quit. When the game exits on its own, the other programs keep running.

While the bottle's WINE server is running, MacLauncher shows that in the selector and keeps the bottle's current synchronization and High Resolution settings, because those can only change once it stops.

Further reading: the [CrossOver](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/CROSSOVER.md#existing-bottles) and [Sikarugir](https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SIKARUGIR.md#existing-wrappers) references.
