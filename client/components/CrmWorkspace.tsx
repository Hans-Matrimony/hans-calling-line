'use client';
import { useEffect, useState } from 'react';
import { API, api } from '../lib/api';
import type { Me } from '../lib/useDialer';

type Call = { id:string;lead_name:string;phone:string;tse_name:string;status:string;created_at:string;answered_at:string|null;bill_seconds:number|null;cost_usd:string|null;recording_id:string|null;hangup_cause:string|null };
type Session = { id:string;tse_name:string;status:string;created_at:string;ended_at:string|null;cost_usd:string|null };
type Lead = {requestId:number;name:string;phone:string;leadType:number};
type Report = {calls:Call[];sessions:Session[];agents:{id:number;name:string;email:string}[];totals:{calls:number;connected:number;bill_seconds:number;cost_usd:string};usdToInr:number};
declare global {interface Window {HansCallingConfig?:{base:string;sdk:string;csrf?:string};HansCalling?:{call:(lead:Lead)=>void;refresh:()=>void};}}
const date=(value:string)=>new Date(value.replace(' ','T')+'Z').toLocaleString('en-IN',{timeZone:'Asia/Kolkata'});
export default function CrmWorkspace({me,onLogout}:{me:Me;onLogout:()=>void}) {
  const [report,setReport]=useState<Report|null>(null),[leads,setLeads]=useState<Lead[]>([]),[error,setError]=useState('');
  const [from,setFrom]=useState(''),[to,setTo]=useState(''),[userId,setUserId]=useState(''),[page,setPage]=useState(0);
  const [widgetReady,setWidgetReady]=useState(false);
  useEffect(()=>{
    if(me.role==='admin')return;
    window.HansCallingConfig={base:API+'/api/calling',sdk:API+'/calling/plivo.js'};
    const script=document.createElement('script');script.src=API+'/calling/widget.js';
    script.onload=()=>setWidgetReady(true);script.onerror=()=>setError('Could not load calling controls. Refresh this page.');document.body.appendChild(script);
    // Reload on logout to fully dispose the shared native widget and its SDK listeners.
  },[me.role]);
  useEffect(()=>{
    let live=true;
    const load=async()=>{
      try {
        const params=new URLSearchParams({from,to,userId,page:String(page)});
        const data=await api<Report>('/api/crm-reports?'+params);
        const pending=me.role==='admin'?null:await api<{leads:Lead[]}>('/api/calling/leads');
        if(live){setReport(data);if(pending)setLeads(pending.leads);setError('');}
      }catch(e){if(live)setError((e as Error).message);}
    };
    load();const timer=setInterval(load,15000);return()=>{live=false;clearInterval(timer);};
  },[from,to,userId,page,me.role]);
  const money=(value:string|null)=>value===null?'Pending':'\u20b9'+(Number(value)*(report?.usdToInr || 80)).toFixed(2);
  return <main style={{maxWidth:1400,margin:'auto',padding:24}}>
    <header style={{display:'flex',justifyContent:'space-between',gap:16}}><div><h1>Hans Calling</h1><p>{me.email} {me.role==='admin'?' / Admin':' / CRM TSE'}</p></div><button onClick={onLogout}>Log out</button></header>
    {error&&<p role="alert">{error}</p>}
    {me.role!=='admin'&&<section><h2>Requested leads</h2><p>Call any requested lead older than 24 hours. Your previous calls do not remove it from this list.</p><div id="hans-calling-notice" role="status"/>
      <table style={{width:'100%'}}><thead><tr><th>Name</th><th>Phone</th><th>Call</th></tr></thead><tbody>{leads.map(lead=><tr key={lead.requestId}><td>{lead.name || 'Requested lead'}</td><td>{lead.phone}</td><td><button disabled={!widgetReady} onClick={()=>window.HansCalling?.call(lead)}>Call</button></td></tr>)}</tbody></table>
      {!leads.length&&<p>No eligible requested leads.</p>}</section>}
    <section><h2>Call history</h2><div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
      <label>From (IST) <input type="date" value={from} onChange={e=>{setFrom(e.target.value);setPage(0);}}/></label>
      <label>Through (IST) <input type="date" value={to} onChange={e=>{setTo(e.target.value);setPage(0);}}/></label>
      {me.role==='admin'&&<label>TSE <select value={userId} onChange={e=>{setUserId(e.target.value);setPage(0);}}><option value="">All TSEs</option>{report?.agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name || agent.email}</option>)}</select></label>}
    </div>
    {report&&<p>{report.totals.calls} calls / {report.totals.connected || 0} connected / {report.totals.bill_seconds} billed seconds / {money(report.totals.cost_usd)} customer call cost</p>}
    <div style={{overflowX:'auto'}}><table style={{width:'100%'}}><thead><tr><th>Date (IST)</th>{me.role==='admin'&&<th>TSE</th>}<th>Lead</th><th>Phone</th><th>Status</th><th>Hangup</th><th>Seconds</th><th>Cost</th><th>Recording</th></tr></thead><tbody>
      {report?.calls.map(call=><tr key={call.id}><td>{date(call.created_at)}</td>{me.role==='admin'&&<td>{call.tse_name}</td>}<td>{call.lead_name}</td><td>{call.phone}</td><td>{call.status}</td><td>{call.hangup_cause || '-'}</td><td>{call.bill_seconds ?? '-'}</td><td>{money(call.cost_usd)}</td><td>{call.recording_id?<a href={API+'/api/crm-recordings/'+call.id} target="_blank" rel="noreferrer">Play</a>:'-'}</td></tr>)}
    </tbody></table></div><button disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button> <span>Page {page+1}</span> <button disabled={!report || report.calls.length<100} onClick={()=>setPage(page+1)}>Next</button>
    </section>
    <section><h2>Recent audio sessions</h2><p>Browser audio charges are shown separately. Costs use the configured USD to INR rate; pending charges update after provider processing.</p><table style={{width:'100%'}}><thead><tr><th>Date (IST)</th><th>TSE</th><th>Status</th><th>Audio cost</th></tr></thead><tbody>{report?.sessions.map(s=><tr key={s.id}><td>{date(s.created_at)}</td><td>{s.tse_name}</td><td>{s.ended_at?'Ended':s.status}</td><td>{money(s.cost_usd)}</td></tr>)}</tbody></table></section>
  </main>;
}
