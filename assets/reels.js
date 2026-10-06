/* Client video reels. Markup per reel:
   <article class="reel" data-src="/x.mp4" data-poster="/x.jpg" data-name="" data-role="" data-link="">
     <div class="reel-media"></div><div class="reel-by">...</div></article>
   Reels autoplay muted while on screen; viewers can pause, unmute or open a
   full screen feed where scrolling down moves to the next reel. */
(function(){
var ICON={
 play:'<svg class="i-off" viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>'+
      '<svg class="i-on" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
 mute:'<svg class="i-off" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>'+
      '<svg class="i-on" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
 fs:'<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
 close:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>'
};
var soundOn=false,players=[];

function btn(cls,html,label){var b=document.createElement('button');b.type='button';b.className='reel-btn '+cls;
 b.innerHTML=html;b.setAttribute('aria-label',label);return b}

/* One video with its controls, inside a .reel-media box. */
function Player(media,data,inFeed){
 var v=document.createElement('video'),self=this;
 v.muted=true;v.defaultMuted=true;v.loop=true;v.playsInline=true;
 v.setAttribute('muted','');v.setAttribute('playsinline','');v.setAttribute('webkit-playsinline','');
 v.preload='none';if(data.poster)v.poster=data.poster;
 v.setAttribute('aria-label','Video review from '+data.name);
 var ctl=document.createElement('div');ctl.className='reel-ctl';
 var bp=btn('reel-play',ICON.play,'Pause'),bm=btn('reel-mute',ICON.mute,'Unmute');
 ctl.appendChild(bp);ctl.appendChild(bm);
 if(!inFeed){var bf=btn('reel-fs',ICON.fs,'Watch full screen');ctl.appendChild(bf);this.fsBtn=bf}
 var bar=document.createElement('div');bar.className='reel-bar';bar.innerHTML='<i></i>';var fill=bar.firstChild;
 media.appendChild(v);media.appendChild(ctl);media.appendChild(bar);
 this.v=v;this.data=data;this.userPaused=false;this.visible=false;
 function sync(){var on=!v.paused;bp.classList.toggle('on',on);bp.setAttribute('aria-label',on?'Pause':'Play');
  var s=!v.muted;bm.classList.toggle('on',s);bm.setAttribute('aria-label',s?'Mute':'Unmute')}
 this.sync=sync;
 v.addEventListener('play',sync);v.addEventListener('pause',sync);v.addEventListener('volumechange',sync);
 v.addEventListener('timeupdate',function(){if(v.duration)fill.style.transform='scaleX('+(v.currentTime/v.duration)+')'});
 function toggle(){if(v.paused){self.userPaused=false;self.play()}else{self.userPaused=true;v.pause()}}
 bp.addEventListener('click',toggle);v.addEventListener('click',toggle);
 bm.addEventListener('click',function(){setSound(v.muted,self)});
 sync();
}
Player.prototype.load=function(){var v=this.v,t=this.startAt;if(v.src)return;
 if(t)v.addEventListener('loadedmetadata',function(){v.currentTime=t},{once:true});
 v.src=this.data.src;v.preload='auto'};
Player.prototype.play=function(){var v=this.v,me=this;this.load();v.muted=!soundOn;
 if(soundOn)players.forEach(function(p){if(p!==me)p.v.muted=true});
 var p=v.play();if(p&&p.catch)p.catch(function(){v.muted=true;v.play().catch(function(){})})};
Player.prototype.show=function(on){this.visible=on;if(on){if(!this.userPaused)this.play()}else this.v.pause()};

/* Sound is one setting for every reel; only the reel being watched plays it. */
function setSound(on,who){soundOn=on;players.forEach(function(p){
 if(p===who){p.v.muted=!on;if(on&&p.v.paused){p.userPaused=false;p.play()}}
 else if(on)p.v.muted=true})}

var io='IntersectionObserver' in window?new IntersectionObserver(function(es){es.forEach(function(e){
 var p=e.target._player;if(p&&!p.held)p.show(e.isIntersecting&&e.intersectionRatio>=.6)})},{threshold:[0,.6]}):null;

function readReel(el){return{src:el.getAttribute('data-src'),poster:el.getAttribute('data-poster'),
 name:el.getAttribute('data-name')||'',role:el.getAttribute('data-role')||'',link:el.getAttribute('data-link')||''}}

function initRow(row){
 var track=row.querySelector('.reels-track'),items=[].slice.call(row.querySelectorAll('.reel')),list=[];
 items.forEach(function(el,i){var d=readReel(el),p=new Player(el.querySelector('.reel-media'),d,false);
  players.push(p);list.push(p);el._player=p;
  if(io)io.observe(el);else{p.v.preload='metadata';p.load()}
  p.fsBtn.addEventListener('click',function(){openFeed(list,i)})});
 if(items.length<2)row.classList.add('fits');
 var prev=row.querySelector('.reels-prev'),next=row.querySelector('.reels-next');
 function step(dir){var w=items[0].getBoundingClientRect().width+16;track.scrollBy({left:dir*w,behavior:'smooth'})}
 function upd(){var max=track.scrollWidth-track.clientWidth;row.classList.toggle('fits',max<4);
  if(prev)prev.disabled=track.scrollLeft<4;if(next)next.disabled=track.scrollLeft>max-4}
 if(prev)prev.addEventListener('click',function(){step(-1)});if(next)next.addEventListener('click',function(){step(1)});
 track.addEventListener('scroll',upd,{passive:true});addEventListener('resize',upd);upd();
}

/* Full screen feed: a vertical, snap-scrolled list of the row's reels. */
function openFeed(list,start){
 var wrap=document.createElement('div');wrap.className='reels-fs';wrap.setAttribute('role','dialog');
 wrap.setAttribute('aria-modal','true');wrap.setAttribute('aria-label','Client video reviews');
 var feed=document.createElement('div');feed.className='reels-fs-feed';wrap.appendChild(feed);
 var close=btn('reels-fs-close',ICON.close,'Close full screen');wrap.appendChild(close);
 var hint=null;if(list.length>1){hint=document.createElement('div');hint.className='reels-fs-hint';hint.textContent='Scroll for the next review';wrap.appendChild(hint)}
 var feedPlayers=[];
 list.forEach(function(src){src.held=true;src.v.pause()});
 list.forEach(function(src,i){var s=document.createElement('section');s.className='reels-fs-slide';
  var m=document.createElement('div');m.className='reel-media';s.appendChild(m);
  var by=document.createElement('div');by.className='reels-fs-by';
  by.innerHTML='<b></b><span></span>';by.firstChild.textContent=src.data.name;by.lastChild.textContent=src.data.role;
  if(src.data.link){var a=document.createElement('a');a.href=src.data.link;a.textContent='Read the case study ↗';by.appendChild(a)}
  m.appendChild(by);
  var p=new Player(m,src.data,true);if(i===start)p.startAt=src.v.currentTime;
  s._player=p;feed.appendChild(s);feedPlayers.push(p);players.push(p)});
 document.body.appendChild(wrap);document.body.classList.add('reels-lock');
 feed.scrollTop=start*feed.clientHeight;
 var fio=new IntersectionObserver(function(es){es.forEach(function(e){var p=e.target._player;
  p.show(e.isIntersecting&&e.intersectionRatio>=.6);
  if(hint&&p.visible&&feedPlayers.indexOf(p)!==start)hint.classList.add('gone')})},{root:feed,threshold:[0,.6]});
 [].forEach.call(feed.children,function(s){fio.observe(s)});
 var req=wrap.requestFullscreen||wrap.webkitRequestFullscreen;
 if(req){try{var r=req.call(wrap);if(r&&r.catch)r.catch(function(){})}catch(e){}}
 function fsEl(){return document.fullscreenElement||document.webkitFullscreenElement}
 function onFs(){if(!fsEl())done()}
 function onKey(e){var h=feed.clientHeight;
  if(e.key==='Escape')done();
  else if(e.key==='ArrowDown'||e.key==='PageDown'){e.preventDefault();feed.scrollBy({top:h,behavior:'smooth'})}
  else if(e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();feed.scrollBy({top:-h,behavior:'smooth'})}}
 var closed=false;
 function done(){if(closed)return;closed=true;fio.disconnect();
  feedPlayers.forEach(function(p){p.v.pause();p.v.removeAttribute('src');p.v.load();players.splice(players.indexOf(p),1)});
  document.removeEventListener('fullscreenchange',onFs);document.removeEventListener('webkitfullscreenchange',onFs);
  document.removeEventListener('keydown',onKey);
  if(fsEl()){var x=document.exitFullscreen||document.webkitExitFullscreen;try{var r=x.call(document);if(r&&r.catch)r.catch(function(){})}catch(e){}}
  wrap.remove();document.body.classList.remove('reels-lock');
  list.forEach(function(src){src.held=false;src.v.muted=!soundOn;if(src.visible&&!src.userPaused)src.play()})}
 close.addEventListener('click',done);
 document.addEventListener('fullscreenchange',onFs);document.addEventListener('webkitfullscreenchange',onFs);
 document.addEventListener('keydown',onKey);
 close.focus();
}

function init(){[].forEach.call(document.querySelectorAll('[data-reels]'),initRow)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
