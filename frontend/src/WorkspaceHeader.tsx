import React from "react";

/** One page title and a quiet location trail shared by the whole desktop app. */
export class WorkspaceHeader extends React.Component<{
  title: string;
  section?: string;
  description?: string;
  actions: React.ReactNode;
}> {
  render() {
    return (
      <header className="workspace-header">
        <div className="workspace-heading">
          <nav className="workspace-path" aria-label="当前位置">
            <span>家庭账本</span>
            {this.props.section && (
              <>
                <span aria-hidden="true">/</span>
                <span>{this.props.section}</span>
              </>
            )}
          </nav>
          <h1>{this.props.title}</h1>
          {this.props.description && <p>{this.props.description}</p>}
        </div>
        <div className="workspace-actions">{this.props.actions}</div>
      </header>
    );
  }
}
