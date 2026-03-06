
let socket;
let user;
let room="general";

function login(){
  user=document.getElementById("username").value;
  let pass=document.getElementById("password").value;

  fetch("/api/login",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({user,pass})
  }).then(r=>r.json()).then(d=>{
    if(d.ok){
      document.getElementById("login").style.display="none";
      document.getElementById("app").style.display="flex";
      start();
    }else{
      alert("login failed");
    }
  });
}

function start(){

  socket=io();

  socket.emit("join",{user,room});

  socket.on("message",m=>{
    let div=document.createElement("div");
    div.className="message";
    div.innerText=m.user+": "+m.text;
    document.getElementById("messages").appendChild(div);
  });

  socket.on("rooms",list=>{
    let r=document.getElementById("rooms");
    r.innerHTML="";
    list.forEach(x=>{
      let d=document.createElement("div");
      d.innerText=x;
      d.onclick=()=>switchRoom(x);
      r.appendChild(d);
    });
  });
}

function send(){
  let text=document.getElementById("msg").value;
  socket.emit("message",{user,text,room});
  document.getElementById("msg").value="";
}

function switchRoom(r){
  room=r;
  document.getElementById("messages").innerHTML="";
  socket.emit("join",{user,room});
}

function createRoom(){
  let r=prompt("room name");
  socket.emit("createRoom",r);
}
