import {sfConn, apiVersion} from "./inspector.js";
/* global initButton lightningflowscanner */

class FlowScanner {
  constructor(sfHost, flowDefId, flowId) {
    this.sfHost = sfHost;
    this.flowDefId = flowDefId;
    this.flowId = flowId;
    this.currentFlow = null;
    this.scanResults = [];
    this.flowScannerCore = null;
    this.init();
  }

  init() {
    this.bindEvents();
    this.initFlowScannerCore();
    this.loadFlowInfo();
  }

  initFlowScannerCore() {
    if (typeof lightningflowscanner !== 'undefined') {
      this.flowScannerCore = lightningflowscanner;
      console.log('Flow Scanner Core loaded successfully');
    } else {
      console.warn('Flow Scanner Core not available, using basic analysis');
    }
  }

  bindEvents() {
    document.getElementById('scan-button').addEventListener('click', () => {
      this.scanFlow();
    });
    document.getElementById('export-button').addEventListener('click', () => {
      this.exportResults();
    });
  }

  async loadFlowInfo() {
    try {
      if (!this.flowDefId || !this.flowId) {
        this.showError('No flow information found in URL');
        return;
      }
      const flowInfo = await this.getFlowMetadata();
      this.currentFlow = flowInfo;
      this.displayFlowInfo(flowInfo);
    } catch (error) {
      console.error('Error loading flow info:', error);
      this.showError('Failed to load flow information');
    }
  }

  async getFlowMetadata() {
    try {
      const defQuery = `SELECT Id, DeveloperName, MasterLabel, ProcessType, Status, ActiveVersionId FROM FlowDefinition WHERE Id='${this.flowDefId}'`;
      const defRes = await sfConn.rest(
        `/services/data/v${apiVersion}/tooling/query/?q=${encodeURIComponent(defQuery)}`
      );
      const def = defRes.records && defRes.records[0];
      if (!def) throw new Error('No definition');

      const versionId = this.flowId || def.ActiveVersionId;
      const flowRes = await sfConn.rest(
        `/services/data/v${apiVersion}/tooling/sobjects/Flow/${versionId}`
      );

      return {
        id: versionId,
        definitionId: this.flowDefId,
        name: def.DeveloperName || def.MasterLabel || 'Unknown Flow',
        type: def.ProcessType || 'Unknown',
        status: def.Status || 'Unknown',
        xmlData: flowRes.Metadata
      };
    } catch (error) {
      console.error('Error getting flow metadata:', error);
      return {
        id: this.flowId,
        definitionId: this.flowDefId,
        name: this.extractFlowNameFromPage() || 'Unknown Flow',
        type: this.extractFlowTypeFromPage() || 'Unknown',
        status: this.extractFlowStatusFromPage() || 'Unknown',
        xmlData: this.extractFlowXMLFromPage()
      };
    }
  }

  extractFlowNameFromPage() {
    const titleElement = document.querySelector('title');
    if (titleElement && titleElement.textContent.includes('Flow Builder')) {
      return titleElement.textContent.replace(' - Flow Builder', '').trim();
    }
    const headerElement = document.querySelector('h1, .slds-page-header__title');
    if (headerElement) {
      return headerElement.textContent.trim();
    }
    return 'Unknown Flow';
  }

  extractFlowTypeFromPage() {
    const pageContent = document.body.textContent;
    if (pageContent.includes('Auto-launched Flow')) return 'AutoLaunchedFlow';
    if (pageContent.includes('Screen Flow')) return 'Flow';
    if (pageContent.includes('Process Builder')) return 'Workflow';
    if (pageContent.includes('Invocable Process')) return 'InvocableProcess';
    return 'Flow';
  }

  extractFlowStatusFromPage() {
    const pageContent = document.body.textContent;
    if (pageContent.includes('Active')) return 'Active';
    if (pageContent.includes('Draft')) return 'Draft';
    if (pageContent.includes('Inactive')) return 'Inactive';
    return 'Unknown';
  }

  extractFlowXMLFromPage() {
    return {
      processType: this.extractFlowTypeFromPage(),
      status: this.extractFlowStatusFromPage(),
      label: this.extractFlowNameFromPage(),
      apiVersion: apiVersion
    };
  }

  displayFlowInfo(flowInfo) {
    document.getElementById('flow-name').textContent = flowInfo.name;
    document.getElementById('flow-type').textContent = `Type: ${flowInfo.type}`;
    document.getElementById('flow-status').textContent = `Status: ${flowInfo.status}`;
  }

  async scanFlow() {
    if (!this.currentFlow) {
      this.showError('No flow loaded');
      return;
    }
    this.showLoading(true);
    try {
      let results = [];
      if (this.flowScannerCore) {
        results = await this.scanWithCore();
      } else {
        results = await this.analyzeFlow(this.currentFlow);
      }
      this.scanResults = results;
      this.displayResults(results);
      this.updateExportButton();
    } catch (error) {
      console.error('Error scanning flow:', error);
      this.showError('Failed to scan flow: ' + error.message);
    } finally {
      this.showLoading(false);
    }
  }

  async scanWithCore() {
    try {
      const mockFlow = {
        name: this.currentFlow.name,
        type: this.currentFlow.type,
        xmldata: this.currentFlow.xmlData,
        elements: this.extractFlowElements()
      };
      const parsedFlows = [{
        uri: this.currentFlow.id,
        flow: mockFlow,
        errorMessage: null
      }];
      const scanResults = this.flowScannerCore.scan(parsedFlows);
      const results = [];
      for (const scanResult of scanResults) {
        for (const ruleResult of scanResult.ruleResults) {
          if (ruleResult.occurs && ruleResult.details && ruleResult.details.length > 0) {
            for (const detail of ruleResult.details) {
              results.push({
                rule: ruleResult.ruleName,
                description: ruleResult.ruleDefinition?.description || ruleResult.ruleName,
                severity: ruleResult.severity || 'warning',
                details: `Flow: ${this.currentFlow.name} - ${detail.name || 'Unknown element'}`
              });
            }
          }
        }
      }
      return results;
    } catch (error) {
      console.error('Error with Flow Scanner Core:', error);
      return await this.analyzeFlow(this.currentFlow);
    }
  }

  extractFlowElements() {
    return [];
  }

  async analyzeFlow(flow) {
    const results = [];
    const rules = [
      {
        name: 'Flow Description',
        description: 'Flow should have a description for better documentation',
        severity: 'warning',
        check: (f) => !f.xmlData?.description
      },
      {
        name: 'API Version',
        description: 'Flow should use a recent API version',
        severity: 'info',
        check: (f) => {
          const ver = parseFloat(f.xmlData?.apiVersion || apiVersion);
          return ver < parseFloat(apiVersion);
        }
      },
      {
        name: 'Flow Status',
        description: 'Active flows should be thoroughly tested',
        severity: 'info',
        check: (f) => f.status === 'Active'
      },
      {
        name: 'Flow Type Check',
        description: 'Consider using Flow instead of Process Builder for new automation',
        severity: 'warning',
        check: (f) => f.type === 'Workflow'
      },
      {
        name: 'Flow Name Convention',
        description: 'Flow names should follow naming conventions',
        severity: 'info',
        check: (f) => {
          const name = f.name || '';
          return !name.includes('_') && !name.includes(' ');
        }
      }
    ];
    for (const rule of rules) {
      if (rule.check(flow)) {
        results.push({
          rule: rule.name,
          description: rule.description,
          severity: rule.severity,
          details: `Flow: ${flow.name}`
        });
      }
    }
    return results;
  }

  displayResults(results) {
    const container = document.getElementById('results-container');
    const totalIssues = document.getElementById('total-issues');
    totalIssues.textContent = results.length;
    if (results.length === 0) {
      container.innerHTML = '<div class="no-results">No issues found! Your flow looks good.</div>';
      return;
    }
    const resultsHTML = results.map(result => `
      <div class="issue-item">
        <div class="issue-header">
          <div class="issue-title">${result.rule}</div>
          <div class="issue-severity ${result.severity}">${result.severity}</div>
        </div>
        <div class="issue-description">${result.description}</div>
        <div class="issue-details">${result.details}</div>
      </div>
    `).join('');
    container.innerHTML = resultsHTML;
  }

  updateExportButton() {
    const exportBtn = document.getElementById('export-button');
    exportBtn.disabled = this.scanResults.length === 0;
  }

  exportResults() {
    if (this.scanResults.length === 0) {
      return;
    }
    const exportData = {
      flow: this.currentFlow,
      scanResults: this.scanResults,
      scanDate: new Date().toISOString(),
      totalIssues: this.scanResults.length,
      scannerVersion: this.flowScannerCore ? 'Flow Scanner Core' : 'Basic Scanner'
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flow-scan-${this.currentFlow.name}-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    overlay.style.display = show ? 'flex' : 'none';
  }

  showError(message) {
    const container = document.getElementById('results-container');
    container.innerHTML = `<div class="no-results" style="color: #c62828;">Error: ${message}</div>`;
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const sfHost = params.get('host');
  const flowDefId = params.get('flowDefId');
  const flowId = params.get('flowId');
  initButton(sfHost, true);
  await sfConn.getSession(sfHost);
  new FlowScanner(sfHost, flowDefId, flowId);
}

document.addEventListener('DOMContentLoaded', init);
