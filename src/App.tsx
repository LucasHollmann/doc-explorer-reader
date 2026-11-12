import FileExplorer from "./components/FileExplorer";
import { LanguageProvider } from "./i18n/LanguageContext";
import "./App.css";

function App() {
  return (
    <LanguageProvider>
      <FileExplorer />
    </LanguageProvider>
  );
}

export default App;
