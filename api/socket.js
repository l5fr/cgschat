
import { Server } from "socket.io"

let io
let users={}
let rooms={general:[]}

export default function handler(req,res){

  if(!res.socket.server.io){
    io=new Server(res.socket.server)
    res.socket.server.io=io

    io.on("connection",socket=>{

      socket.on("join",({user,room})=>{
        socket.join(room)
        if(!rooms[room]) rooms[room]=[]
        io.emit("rooms",Object.keys(rooms))
      })

      socket.on("createRoom",room=>{
        if(!rooms[room]) rooms[room]=[]
        io.emit("rooms",Object.keys(rooms))
      })

      socket.on("message",m=>{
        rooms[m.room].push(m)
        io.to(m.room).emit("message",m)
      })

    })
  }

  res.end()
}
