'use client';
import { useEffect, useState } from 'react';
import { API, api } from '../lib/api';
import type { Me } from '../lib/useDialer';
import { Grid, Phone, List, Activity, LogOut, Refresh, Play } from './icons';

type Call = { id:string;lead_name:string;phone:string;tse_name:string;status:string;created_at:string;answered_at:string|null;ended_at:string|null;bill_seconds:number|null;cost_usd:string|null;recording_id:string|null;hangup_cause:string|null };
type Session = { id:string;tse_name:string;status:string;created_at:string;ended_at:string|null;cost_usd:string|null };
type Lead = {requestId:number;name:string;phone:string;leadType:number};
type Report = {calls:Call[];sessions:Session[];agents:{id:number;name:string;email:string}[];totals:{calls:number;connected:number;bill_seconds:number;cost_usd:string};usdToInr:number};
declare global {interface Window {HansCallingConfig?:{base:string;sdk:string;csrf?:string};HansCalling?:{call:(lead:Lead)=>void;refresh:()=>void};}}
const date=(value:string)=>new Date(value.replace(' ','T')+'Z').toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
type View = 'overview' | 'calls' | 'sessions' | 'leads';
const titles: Record<View,string> = {overview:'Overview',calls:'Call history',sessions:'Audio sessions',leads:'Requested leads'};
function Status({value}:{value:string}) {
  const color=['ready','live'].includes(value)?'green':['starting','ringing'].includes(value)?'amber':['failed','uncertain'].includes(value)?'coral':'grey';
  const label:Record<string,string>={ready:'Audio ready',live:'Connected',starting:'Connecting',ringing:'Ringing',ended:'Ended',failed:'Failed',uncertain:'Checking status'};
  return <span className={'ad-pill '+color}><span className={'lamp '+color}/>{label[value] || value}</span>;
}
export default function CrmWorkspace({me,onLogout}:{me:Me;onLogout:()=>void}) {
  const [report,setReport]=useState<Report|null>(null),[leads,setLeads]=useState<Lead[]>([]),[error,setError]=useState('');
  const [from,setFrom]=useState(''),[to,setTo]=useState(''),[userId,setUserId]=useState(''),[page,setPage]=useState(0);
  const [widgetReady,setWidgetReady]=useState(false);
  const [view,setView]=useState<View>(me.role==='admin'?'overview':'leads');
  const [refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true),[updated,setUpdated]=useState('');
  useEffect(()=>{
    if(me.role==='admin')return;
    window.HansCallingConfig={base:API+'/api/calling',sdk:API+'/calling/plivo.js'};
    const script=document.createElement('script');script.src=API+'/calling/widget.js';
    script.onload=()=>setWidgetReady(true);script.onerror=()=>setError('Could not load calling controls. Refresh this page.');document.body.appendChild(script);
    // Reload on logout to fully dispose the shared native widget and its SDK listeners.
  },[me.role]);
  useEffect(()=>{
    let live=true;
    setLoading(true);
    const load=async()=>{
      try {
        const params=new URLSearchParams({from,to,userId,page:String(page)});
        const data=await api<Report>('/api/crm-reports?'+params);
        const pending=me.role==='admin'?null:await api<{leads:Lead[]}>('/api/calling/leads');
        if(live){setReport(data);if(pending)setLeads(pending.leads);setError('');setUpdated(new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}));}
      }catch(e){if(live)setError((e as Error).message);}finally{if(live)setLoading(false);}
    };
    load();const timer=setInterval(load,15000);return()=>{live=false;clearInterval(timer);};
  },[from,to,userId,page,me.role,refresh]);
  const money=(value:string|null)=>value===null?'Pending':'\u20b9'+(Number(value)*(report?.usdToInr || 80)).toFixed(2);
  const admin=me.role==='admin';
  const connected=Number(report?.totals.connected || 0),count=Number(report?.totals.calls || 0);
  const nav=[{id:'overview' as View,icon:Grid},{id:'calls' as View,icon:Phone},{id:'sessions' as View,icon:Activity},...(!admin?[{id:'leads' as View,icon:List}]:[])];
  const callTable=(preview=false)=><section className="panel crm-report-panel" aria-label="Call history">
    <div className="panel-head"><div><h2 className="crm-panel-title">{preview?'Recent calls':'Call history'}</h2><p className="crm-caption">Customer calls for the selected period. Times shown in IST.</p></div>
      {preview?<button className="btn btn-mini" onClick={()=>setView('calls')}>View all calls</button>:<span className="ad-pill blue">{count.toLocaleString('en-IN')} calls</span>}</div>
    <div className="ad-scroll"><table className="ad-tbl crm-table"><thead><tr><th>Date (IST)</th>{admin&&<th>TSE</th>}<th>Lead</th><th>Phone</th><th>Status</th><th>Hangup reason</th><th className="num">Seconds</th><th className="num">Cost</th><th>Recording</th></tr></thead><tbody>
      {(preview?report?.calls.slice(0,6):report?.calls)?.map(call=><tr key={call.id}><td className="crm-date">{date(call.created_at)}</td>{admin&&<td>{call.tse_name || 'TSE'}</td>}<td className="name">{call.lead_name || 'Requested lead'}</td><td className="mono crm-phone">{call.phone}</td><td><Status value={call.status}/></td><td className="crm-cause">{call.hangup_cause?.replaceAll('_',' ').toLowerCase() || '\u2014'}</td><td className="num">{call.bill_seconds ?? '\u2014'}</td><td className="num">{money(call.cost_usd)}</td><td>{call.recording_id?<a className="btn btn-mini crm-recording" href={API+'/api/crm-recordings/'+call.id} target="_blank" rel="noreferrer" aria-label={'Play recording for '+(call.lead_name || call.phone)}><Play/>Play</a>:<span className="muted">{call.ended_at?'Unavailable':'Pending'}</span>}</td></tr>)}
      {!report?.calls.length&&<tr><td colSpan={admin?9:8}><div className="crm-empty"><Phone/><strong>{loading?'Loading calls...':'No calls in this period'}</strong><span>{loading?'Getting your latest calling activity.':'Calls placed through CRM will appear here. Try a different date or TSE filter.'}</span></div></td></tr>}
    </tbody></table></div>
    {!preview&&<div className="ad-tfoot"><span>Page {page+1} <span className="muted">/ up to 100 calls per page</span></span><div className="crm-actions"><button className="btn btn-mini" disabled={page===0 || loading} onClick={()=>setPage(page-1)}>Previous</button><button className="btn btn-mini" disabled={!report || report.calls.length<100 || loading} onClick={()=>setPage(page+1)}>Next</button></div></div>}
  </section>;
  const sessions=<section className="panel crm-report-panel" aria-label="Recent audio sessions">
    <div className="panel-head"><div><h2 className="crm-panel-title">Recent audio sessions</h2><p className="crm-caption">Latest 100 browser audio connections, independent of the call-history filters.</p></div><span className="ad-pill">Audio</span></div>
    <div className="ad-scroll"><table className="ad-tbl crm-table"><thead><tr><th>Date (IST)</th><th>TSE</th><th>Status</th><th className="num">Audio cost</th></tr></thead><tbody>{(view==='overview'?report?.sessions.slice(0,5):report?.sessions)?.map(session=><tr key={session.id}><td className="crm-date">{date(session.created_at)}</td><td className="name">{session.tse_name || 'TSE'}</td><td><Status value={session.ended_at?'ended':session.status}/></td><td className="num">{money(session.cost_usd)}</td></tr>)}
      {!report?.sessions.length&&<tr><td colSpan={4}><div className="crm-empty"><Activity/><strong>{loading?'Loading audio sessions...':'No audio sessions yet'}</strong><span>Audio connects when a TSE starts a call.</span></div></td></tr>}
    </tbody></table></div><p className="crm-caption crm-cost-note">Audio charges are separate from customer call charges. Pending costs update after provider processing.</p>
  </section>;
  return <div className="ad-shell crm-workspace">
    <aside className="side"><div className="brand"><span className="brand-name">Hans</span><span className="brand-sub">{admin?'Admin':'Calling'}</span></div>
      <nav aria-label="Calling workspace">{nav.map(item=><button key={item.id} className={'nav'+(view===item.id?' on':'')} onClick={()=>{setView(item.id);setPage(0);}} aria-current={view===item.id?'page':undefined}><item.icon/>{titles[item.id]}</button>)}</nav>
      <div className="ad-foot"><span className="ad-pill blue">CRM workspace</span><p>Reporting days use India Standard Time.</p></div>
    </aside>
    <main className="ad-main">
      <header className="topbar"><div><span className="crm-eyebrow">Hans Calling</span><h1>{titles[view]}</h1></div><div className="crm-account"><span className="ad-pill blue">{admin?'Admin':'CRM TSE'}</span><span className="crm-email" title={me.email}>{me.email}</span><button className="btn btn-ghost" onClick={onLogout} aria-label="Log out" title="Log out"><LogOut/></button></div></header>
      <div className="ad-filters crm-filters">
        {(view==='overview' || view==='calls')&&<><label><span className="ad-lbl">From (IST)</span><input type="date" value={from} max={to || undefined} onChange={e=>{setFrom(e.target.value);setPage(0);}}/></label><label><span className="ad-lbl">Through (IST)</span><input type="date" value={to} min={from || undefined} onChange={e=>{setTo(e.target.value);setPage(0);}}/></label>
          {admin&&<label><span className="ad-lbl">TSE</span><select value={userId} onChange={e=>{setUserId(e.target.value);setPage(0);}}><option value="">All TSEs</option>{report?.agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name || agent.email}</option>)}</select></label>}
          {(from || to || userId)&&<button className="btn btn-mini" onClick={()=>{setFrom('');setTo('');setUserId('');setPage(0);}}>Clear filters</button>}</>}
        <div className="crm-refresh"><span className="crm-caption">{loading?'Updating...':updated?'Updated '+updated+' IST':''}</span><button className="btn" aria-label="Refresh dashboard" disabled={loading} onClick={()=>setRefresh(value=>value+1)}><Refresh/>Refresh</button></div>
      </div>
      <div className="ad-screen crm-screen" aria-busy={loading}>
        {error&&<div className="crm-error" role="alert"><strong>Could not update dashboard</strong><p>{error}</p><button className="btn btn-mini" onClick={()=>setRefresh(value=>value+1)}>Try again</button></div>}
        {(view==='overview' || view==='calls')&&<div className="ad-kpis crm-kpis">
          <div className="ad-kpi hero"><span className="l">Connection rate</span><strong className="v">{report?(count?Math.round(connected/count*100):0)+'%':'\u2014'}</strong><span className="d">{connected.toLocaleString('en-IN')} connected of {count.toLocaleString('en-IN')} calls</span></div>
          <div className="ad-kpi"><span className="l">Total calls</span><strong className="v">{report?count.toLocaleString('en-IN'):'\u2014'}</strong><span className="d">Selected period</span></div>
          <div className="ad-kpi"><span className="l">Billed duration</span><strong className="v">{report?Math.floor(Number(report.totals.bill_seconds)/60).toLocaleString('en-IN'):'\u2014'}<small>min</small></strong><span className="d">Customer call duration</span></div>
          <div className="ad-kpi"><span className="l">Customer call cost</span><strong className="v">{report?money(report.totals.cost_usd):'\u2014'}</strong><span className="d">Excludes browser audio</span></div>
        </div>}
        {view==='overview'&&<>{callTable(true)}{sessions}</>}
        {view==='calls'&&callTable()}
        {view==='sessions'&&sessions}
        {view==='leads'&&!admin&&<section className="panel crm-report-panel"><div className="panel-head"><div><h2 className="crm-panel-title">Ready to call</h2><p className="crm-caption">Requested leads older than 24 hours. Previously called leads can be called again.</p></div><span className="ad-pill blue">{leads.length} leads</span></div><div id="hans-calling-notice" role="status"/>
          <div className="ad-scroll"><table className="ad-tbl crm-table"><thead><tr><th>Name</th><th>Phone</th><th>Action</th></tr></thead><tbody>{leads.map(lead=><tr key={lead.requestId}><td className="name">{lead.name || 'Requested lead'}</td><td className="mono">{lead.phone}</td><td><button className="btn btn-blue" disabled={!widgetReady} onClick={()=>window.HansCalling?.call(lead)}><Phone/>Call</button></td></tr>)}
          {!leads.length&&<tr><td colSpan={3}><div className="crm-empty"><List/><strong>{loading?'Loading requested leads...':'No eligible requested leads'}</strong><span>Request leads in CRM. Fresh leads become callable after 24 hours.</span></div></td></tr>}
          </tbody></table></div></section>}
        <footer className="crm-footer"><span>Hans Calling / CRM</span><span>Costs shown in INR at the configured conversion rate.</span></footer>
      </div>
    </main>
  </div>;
}
