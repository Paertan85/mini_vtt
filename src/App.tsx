// The DM window's layout: the library panel, the toolbar, the banner while
// players see something other than the map, the grid measuring bar, the map
// area with the current tool's hint, and the dialogs. What they show and do comes from useDmController.

import { MapLibraryPanel } from './components/MapLibraryPanel';
import { MapStage } from './components/MapStage';
import { Toolbar } from './components/Toolbar';
import { PlayerSetupDialog, ShortcutsDialog, WelcomeDialog } from './components/Dialogs';
import { GridCalibrationBar } from './components/GridCalibrationBar';
import { ToolHint } from './components/ToolHint';
import { useDmController } from './hooks/useDmController';
import { Button } from './ui/controls';
import { keyLabel } from './lib/platform';
import { NotificationHost } from './ui/notify';

export function App() {
  const dm = useDmController();
  const { playerScreen, dialogs, calibration } = dm;

  return (
    <div className="flex h-full bg-ground text-ink">
      <MapLibraryPanel
        library={dm.library}
        playerScreen={playerScreen}
        hidden={!dm.settings.showLibrary || dm.settings.interfaceHidden}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Hidden, not removed, so the toolbar keeps its state while the map fills the window */}
        <div className={dm.settings.interfaceHidden ? 'hidden' : 'contents'}>
          <Toolbar
            tools={dm.tools}
            playerView={dm.playerView}
            playerScreen={playerScreen}
            settings={dm.settings}
            app={dm.app}
          />
        </div>

        {playerScreen.killScreen ? (
          <div className="flex h-9 shrink-0 items-center gap-3 border-b border-crimson bg-crimson-deep px-3 text-[13px]">
            <span className="h-2 w-2 rounded-full bg-crimson-bright" aria-hidden="true" />
            <span className="flex-1 text-ink">
              {keyLabel('Players see the kill screen. Ctrl+K hides it.')}
            </span>
          </div>
        ) : (
          (playerScreen.blackout || playerScreen.activeHandoutId) && (
            <div className="flex h-9 shrink-0 items-center gap-3 border-b border-crimson bg-crimson-deep px-3 text-[13px]">
              <span className="h-2 w-2 rounded-full bg-crimson-bright" aria-hidden="true" />
              <span className="flex-1 text-ink">
                {playerScreen.blackout
                  ? 'The player screen is blacked out.'
                  : `Players are looking at the handout “${playerScreen.activeHandoutName ?? 'Handout'}”.`}
              </span>
              <Button
                tone="quiet"
                className="h-7"
                onClick={playerScreen.blackout ? playerScreen.toggleBlackout : playerScreen.hideHandout}
              >
                {playerScreen.blackout ? 'Show the map' : 'Hide handout'}
              </Button>
            </div>
          )
        )}

        {calibration && (
          <GridCalibrationBar
            calibration={calibration.calibration}
            preview={calibration.preview}
            hasGrid={calibration.hasGrid}
            onChange={calibration.change}
            onSave={calibration.save}
            onRemove={calibration.remove}
            onCancel={calibration.cancel}
          />
        )}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <MapStage {...dm.stage} />
          {dm.tools.hasMap && dm.settings.showToolHints && !dm.settings.interfaceHidden && !calibration && (
            <ToolHint tool={dm.tools.tool} fogShape={dm.tools.fogShape} />
          )}
        </div>
      </div>

      {dialogs.open === 'setup' && (
        <PlayerSetupDialog
          diagonal={dialogs.screenDiagonal}
          gridSize={dialogs.gridSize}
          portraitRotation={dialogs.portraitRotation}
          frameColor={dialogs.frameColor}
          viewportSize={dialogs.viewportSize}
          onSave={dialogs.savePlayerSetup}
          onClose={dialogs.close}
        />
      )}
      {dialogs.open === 'shortcuts' && <ShortcutsDialog onClose={dialogs.close} />}
      {dialogs.open === 'welcome' && (
        <WelcomeDialog
          showOnStartup={dialogs.showWelcome}
          onShowOnStartupChange={dialogs.setShowWelcome}
          onOpenPlayerSetup={dm.app.openPlayerSetup}
          onOpenShortcuts={dm.app.openShortcuts}
          onClose={dialogs.close}
        />
      )}
      <NotificationHost />
    </div>
  );
}

export default App;
