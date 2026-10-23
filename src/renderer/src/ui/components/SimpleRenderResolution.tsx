import React, { useEffect, useState } from "react";
import type { GameGraphicsSettings, GraphicsInputs, RecentGame, ShaderTraits } from "../types";
import { RENDER_DIVISORS } from "../../../../modules/shared/effects/plan.mjs";
import { HelpTip } from "./HelpTip";

export function resizingShader(traits?: ShaderTraits | null) {
  return Boolean(traits?.outputScale || traits?.conditionalGeometry || traits?.displayDependentGeometry || traits?.unresolvedGeometry);
}
const resolutionLabel = (factor: number) => factor === 1 ? "100% · Original" : `${Math.round(1000 / factor) / 10}% · ${factor}× upscale`;

export function SimpleRenderResolution({ game, multipliers, sourceResolution, shaderTraits, processingAvailable = false, onChange }: {
  game: Pick<RecentGame, "gamePath" | "graphics" | "reshade" | "runtimeId">;
  multipliers: number[]; sourceResolution?: GraphicsInputs["sourceResolution"]; shaderTraits?: ShaderTraits; processingAvailable?: boolean;
  onChange: (gamePath: string, patch: Partial<GameGraphicsSettings>) => Promise<void>;
}) {
  const custom = game.reshade?.enabled && game.reshade.preset === "custom" && /\.(?:glsl|hook)$/i.test(game.reshade.effectPath || "");
  const identity = JSON.stringify([game.gamePath, game.runtimeId, game.reshade?.effectPath]);
  const [resolved, setResolved] = useState<{ identity: string; traits?: ShaderTraits } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!custom || game.graphics?.neuralMethod === "mlx-dlss") return;
    let active = true;
    Promise.resolve().then(() => window.MacLauncher?.launcher.getGameEffects(game.gamePath)).then(info => {
      if (active) setResolved({ identity, traits: info?.selectedShaderTraits });
    }).catch(() => { if (active) setResolved({ identity }); });
    return () => { active = false; };
  }, [identity, custom, game.graphics?.neuralMethod]);
  const traits = custom ? resolved?.identity === identity ? resolved.traits : undefined : shaderTraits;
  const value = game.graphics?.spatialMultiplier ?? null;
  const choices = RENDER_DIVISORS.filter(factor => processingAvailable || multipliers.includes(factor));
  const label = multipliers.length || !processingAvailable ? "Render resolution" : "Processing resolution";
  const enabled = Boolean(game.graphics?.spatialShader) || game.graphics?.spatialMethod && game.graphics.spatialMethod !== "off" || game.reshade?.enabled && resizingShader(traits);
  if (game.graphics?.neuralMethod === "mlx-dlss" || !enabled || !choices.length && value === null) return null;
  async function change(value: string) {
    setError("");
    try {await onChange(game.gamePath, {spatialMultiplier: value === "auto" ? null : Number(value)});}
    catch (error) {setError(error instanceof Error ? error.message : "Render resolution could not be saved.");}
  }
  return <><div className="detailRow detailControlRow">
    <label className="detailLabel" htmlFor="game-resolution-multiplier">{label} <HelpTip label={`About ${label.toLowerCase()}`}>{!choices.length
      ? "The selected runtime does not provide source resolution control. Auto retains the original renderer's resolution."
      : <>{sourceResolution && sourceResolution.control === "engine" ? "Adjusts the game's 3D render scale. Window size and 2D content stay unchanged. " : ""}{value === null
        ? "Auto preserves the game's render resolution and scales smaller frames to fit the window. Scaling stays inactive when both resolutions match. Output uses the window's physical pixels, including Retina scaling."
        : value === 1 ? "Preserves the original input resolution. Window and fullscreen size stay unchanged."
          : `${value}× upscaling processes at 1/${value} of the output width and height, then upscales to the unchanged window or fullscreen size. ${value === 2 ? "For example, 1920 × 1080 uses 960 × 540, one quarter as many pixels. " : ""}Already smaller inputs remain unchanged.`}
        {processingAvailable && " Uses renderer source sizing when available; otherwise downsamples completed frames before upscaling. Completed-frame reduction does not reduce the game's rendering work."}</>}</HelpTip></label>
    <select id="game-resolution-multiplier" className="input" value={value ?? "auto"}
      onChange={event => void change(event.target.value)}>
      <option value="auto">Auto · Game resolution</option>
      {value !== null && !choices.includes(value) && <option value={value} disabled>{resolutionLabel(value)} · Unavailable</option>}
      {choices.map(factor => <option key={factor} value={factor}>{resolutionLabel(factor)}</option>)}
    </select>
  </div>{error && <p className="detailMeta" role="alert">{error}</p>}</>;
}
