// src/App.tsx
import React, { useEffect, useRef, useState } from "react";
import { Geometry, GameSettings, GameCommands, startGame } from "./gameEngine";

const VIEW_W = 900;
const VIEW_H = 560;
const MINIMAP_W = 180;
const MINIMAP_H = 180;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);

  // UI state
  const [geom, setGeom] = useState<Geometry>("euclidean");
  const [mysteryMode, setMysteryMode] = useState(false);
  const [mysteryGeom, setMysteryGeom] = useState<Geometry>("euclidean");
  const [baseSpeed, setBaseSpeed] = useState(220);
  const [slopeAngle, setSlopeAngle] = useState(30 * (Math.PI / 180));
  const [slopeStrength, setSlopeStrength] = useState(0.6);
  const [showLocalGrid, setShowLocalGrid] = useState(true);
  const [localGridCell, setLocalGridCell] = useState(100);
  const [localGridRadius, setLocalGridRadius] = useState(4);
  const [trailEnabled, setTrailEnabled] = useState(false);

  // settings & commands refs for engine
  const settingsRef = useRef<GameSettings>({
    geom,
    mysteryMode,
    mysteryGeom,
    baseSpeed,
    slopeAngle,
    slopeStrength,
    showLocalGrid,
    localGridCell,
    localGridRadius,
    trailEnabled,
  });

  const commandsRef = useRef<GameCommands>({
    clearMarkers: false,
    clearTrail: false,
  });

  // keep settingsRef in sync with UI
  useEffect(() => {
    settingsRef.current = {
      geom,
      mysteryMode,
      mysteryGeom,
      baseSpeed,
      slopeAngle,
      slopeStrength,
      showLocalGrid,
      localGridCell,
      localGridRadius,
      trailEnabled,
    };
  }, [
    geom,
    mysteryMode,
    mysteryGeom,
    baseSpeed,
    slopeAngle,
    slopeStrength,
    showLocalGrid,
    localGridCell,
    localGridRadius,
    trailEnabled,
  ]);

  // start engine once
  useEffect(() => {
    if (!canvasRef.current) return;
    const stop = startGame(
      canvasRef.current,
      minimapRef.current,
      settingsRef,
      commandsRef
    );
    return stop;
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-6xl grid grid-cols-1 gap-4">
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Géométries de la Grenouille
            </h1>
            <p className="text-slate-600">
              Déplace la grenouille 🐸 et ressens comment se comportent les différents
              espaces.
            </p>
          </div>

          <div className="flex flex-col items-start gap-2 md:items-end">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={mysteryMode}
                onChange={(e) => {
                  const on = e.target.checked;
                  setMysteryMode(on);
                  if (on) {
                    const choices: Geometry[] = [
                      "euclidean",
                      "spherical",
                      "hyperbolic",
                      "cylindrical",
                    ];
                    const rand =
                      choices[Math.floor(Math.random() * choices.length)];
                    setMysteryGeom(rand);
                  }
                }}
              />
              <span>Mode mystère (géométrie masquée)</span>
            </label>

            {!mysteryMode && (
              <select
                value={geom}
                onChange={(e) => setGeom(e.target.value as Geometry)}
                className="px-3 py-2 rounded-2xl border border-slate-300 bg-white shadow-sm"
              >
                <option value="euclidean">Euclidienne</option>
                <option value="spherical">Sphérique</option>
                <option value="hyperbolic">Hyperbolique</option>
                <option value="cylindrical">Cylindrique</option>
              </select>
            )}

            {mysteryMode && (
              <p className="text-sm text-slate-600">
                Tu es maintenant dans : <strong>MONDE MYSTÈRE</strong>
              </p>
            )}
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[auto_200px] gap-4">
          <div className="relative rounded-2xl bg-white shadow p-3">
            <canvas
              ref={canvasRef}
              width={VIEW_W}
              height={VIEW_H}
              className="w-full h-auto rounded-xl border border-slate-200"
            />
            <div className="absolute left-3 bottom-3 flex items-center gap-2 text-sm bg-white/80 backdrop-blur rounded-full px-3 py-1 shadow border border-slate-200">
              <span className="font-medium">Commandes :</span>
              <span>WASD/Flèches pour se déplacer, M = marqueur, T = dessiner</span>
            </div>
          </div>

          <div className="grid gap-4">
            <div className="rounded-2xl bg-white shadow p-3">
              <canvas
                ref={minimapRef}
                width={MINIMAP_W}
                height={MINIMAP_H}
                className="w-full rounded-lg border border-slate-200"
              />
            </div>
            <div className="rounded-2xl bg-white shadow p-4 grid gap-3">
              <h2 className="font-semibold">Paramètres</h2>
              <label className="grid gap-1">
                <span className="text-sm text-slate-600">
                  Vitesse de base : {Math.round(baseSpeed)} px/s
                </span>
                <input
                  type="range"
                  min={80}
                  max={400}
                  step={10}
                  value={baseSpeed}
                  onChange={(e) => setBaseSpeed(parseFloat(e.target.value))}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-sm text-slate-600">
                  Angle de la pente : {Math.round((slopeAngle * 180) / Math.PI)}°
                </span>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={(slopeAngle * 180) / Math.PI}
                  onChange={(e) =>
                    setSlopeAngle(
                      (parseFloat(e.target.value) * Math.PI) / 180
                    )
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className="text-sm text-slate-600">
                  Force de la pente : {slopeStrength.toFixed(2)}
                </span>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={slopeStrength}
                  onChange={(e) => setSlopeStrength(parseFloat(e.target.value))}
                />
              </label>
              <p className="text-xs text-slate-500">
                La pente influence la vitesse uniquement en géométrie euclidienne
                (plus rapide en descendant, plus lent en montant).
              </p>

              <hr className="my-2" />

              <h3 className="font-medium">Grille locale autour de la grenouille</h3>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showLocalGrid}
                  onChange={(e) => setShowLocalGrid(e.target.checked)}
                />
                <span>Afficher la grille locale (centrée sur la grenouille)</span>
              </label>
              <label className="grid gap-1">
                <span className="text-sm text-slate-600">
                  Taille des cellules : {localGridCell}px
                </span>
                <input
                  type="range"
                  min={40}
                  max={200}
                  step={10}
                  value={localGridCell}
                  onChange={(e) =>
                    setLocalGridCell(parseFloat(e.target.value))
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className="text-sm text-slate-600">
                  Rayon (en cellules) : {localGridRadius}
                </span>
                <input
                  type="range"
                  min={2}
                  max={8}
                  step={1}
                  value={localGridRadius}
                  onChange={(e) =>
                    setLocalGridRadius(parseFloat(e.target.value))
                  }
                />
              </label>

              <label className="flex items-center gap-2 text-sm mt-2">
                <input
                  type="checkbox"
                  checked={trailEnabled}
                  onChange={(e) => setTrailEnabled(e.target.checked)}
                />
                <span>Afficher la trace</span>
              </label>

              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => {
                    commandsRef.current.clearMarkers = true;
                  }}
                  className="px-2 py-1 rounded-xl bg-red-200 text-xs"
                >
                  Effacer les marqueurs
                </button>
                <button
                  onClick={() => {
                    commandsRef.current.clearTrail = true;
                  }}
                  className="px-3 py-1 rounded-xl bg-green-200 text-xs"
                >
                  Effacer la trace
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer className="text-xs text-slate-500">
          Règles géométriques implémentées :
          <ul className="list-disc ml-5 mt-1 space-y-1">
            <li>
              <strong>Euclidienne :</strong> plan infini ; la pente modifie la
              vitesse par projection.
            </li>
            <li>
              <strong>Sphérique (tore) :</strong> continuité sur les deux axes.
            </li>
            <li>
              <strong>Hyperbolique :</strong> le monde principal semble euclidien ;
              la mini-carte ralentit vers les bords.
            </li>
            <li>
              <strong>Cylindrique :</strong> continuité seulement sur l’axe vertical.
            </li>
          </ul>
        </footer>
      </div>
    </div>
  );
}
