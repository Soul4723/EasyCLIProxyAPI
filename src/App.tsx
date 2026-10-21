import { WindowFrame } from './components/WindowFrame';
import { CoreRuntimeProvider } from './coreRuntime';
import { CoreUpdateProvider } from './coreUpdate';
import { AppUpdateProvider } from './appUpdate';
import { Shell } from './shell/Shell';

function App() {
  return (
    <AppUpdateProvider>
      <CoreRuntimeProvider>
        <CoreUpdateProvider>
          <WindowFrame><Shell /></WindowFrame>
        </CoreUpdateProvider>
      </CoreRuntimeProvider>
    </AppUpdateProvider>
  );
}

export default App;
