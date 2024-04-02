import { useState, useEffect } from 'react'
import './App.css'
import { Table } from 'react-bootstrap';

import { Navbar, Container } from 'react-bootstrap';
import 'bootstrap/dist/css/bootstrap.min.css';


function NavigationBar() {
  return (
    <Navbar bg="dark" variant="dark" fixed="top">
      <Container>
        <Navbar.Brand href="#home">Openbot</Navbar.Brand>
      </Container>
    </Navbar>
  );
}

function MessageBoard({ messages }) {
  return (
    <div className="mt-5">
      <h1>Bot info</h1>
      <Table striped bordered hover>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Level</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((msg, index) => (
            <tr key={index}>
              <td>{msg.timestamp}</td>
              <td>{msg.level}</td>
              <td>{msg.message}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}


function App() {
  const [count, setCount] = useState(0)
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    //const ws = new WebSocket('ws://' + window.location.hostname);
    const ws = new WebSocket('ws://localhost:3000');

    ws.onopen = () => {
      console.log('Connected to the server');
    };

    ws.onmessage = (event) => {
      console.log('Message from server: ', event.data);
      try {
        const logEntry = JSON.parse(event.data);
        setMessages(prevMessages => [...prevMessages, logEntry]);
      } catch (e) {
        console.error('Error parsing message from server:', e);
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from the server');
    };

    return () => {
      ws.close();
    };
  }, []);

  return (
    <>
      <NavigationBar />
      <Container className="pt-5" style={{ minHeight: '100vh', display: 'block' }}>
        <MessageBoard messages={messages} />
      </Container>
    </>
  )
}

export default App
