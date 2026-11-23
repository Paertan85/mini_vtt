// The DM window's layout: the library panel, the toolbar, the grid measuring
// bar, the tool rail beside the map area with the current tool's hint, the
// player bar beneath it (which also says when players see something other than
// the map), and the dialogs. What they show and do comes from useDmController.

import { MapLibraryPanel } from './components/MapLibraryPanel';
import { MapStage } from './components/MapStage';
import { Toolbar } from './components/Toolbar';
import { ToolRail } from './components/ToolRail';
import { PlayerBar } from './components/PlayerBar';
import { ShortcutsDialog, WelcomeDialog } from './components/Dialogs';
import { SettingsDialog } from './components/SettingsDialog';
import { GridCalibrationBar } from './components/GridCalibrationBar';
import { ToolHint } from './components/ToolHint';
import { useDmController } from './hooks/useDmController';
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
          <Toolbar tools={dm.tools} settings={dm.settings} app={dm.app} />
        </div>

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

        <div className="flex min-h-0 flex-1">
          {!dm.settings.interfaceHidden && (
            <ToolRail
              tool={dm.tools.tool}
              setTool={dm.tools.setTool}
              hasMap={dm.tools.hasMap}
              showEffectTools={dm.settings.showEffectTools}
            />
          )}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <MapStage {...dm.stage} />
            {dm.tools.hasMap && dm.settings.showToolHints && !dm.settings.interfaceHidden && !calibration && (
              <ToolHint tool={dm.tools.tool} fogShape={dm.tools.fogShape} />
            )}
          </div>
        </div>

        <PlayerBar
          playerView={dm.playerView}
          playerScreen={playerScreen}
          hasMap={dm.tools.hasMap}
          openSettings={dm.app.openSettings}
          statusOnly={dm.settings.interfaceHidden}
        />
      </div>

      {dialogs.open === 'settings' && (
        <SettingsDialog
          settings={dm.settings}
          app={dm.app}
          viewportSize={dialogs.viewportSize}
          onClose={dialogs.close}
        />
      )}
      {dialogs.open === 'shortcuts' && <ShortcutsDialog onClose={dialogs.close} />}
      {dialogs.open === 'welcome' && (
        <WelcomeDialog
          showOnStartup={dialogs.showWelcome}
          onShowOnStartupChange={dialogs.setShowWelcome}
          onOpenSettings={dm.app.openSettings}
          onOpenShortcuts={dm.app.openShortcuts}
          onClose={dialogs.close}
        />
      )}
      <NotificationHost />
    </div>
  );
}

export default App;
