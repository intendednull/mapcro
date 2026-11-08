import { render } from "solid-js/web";
import { App } from "./App";
import { suppressContextMenu } from "./core/contextmenu";
import "./styles/minimap.css";
import "./styles/topbar.css";
import "./styles/board.css";
import "./styles/app.css";

suppressContextMenu();
render(() => <App />, document.getElementById("root")!);
